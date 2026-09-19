import { createRequire } from 'node:module';
import { randomUUID, X509Certificate, createPrivateKey, createPublicKey } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { Worker } from 'node:worker_threads';
import { DOMParser } from '@xmldom/xmldom';
import * as samlify from 'samlify';
import type { EnterpriseProfileV3, EnterpriseScope } from '@ghcp/shared';
import { readEnterpriseSecret } from '@ghcp/shared/enterpriseRuntimeV3';
import { getScopeProfile } from '../enterprise.js';
import type { SsoUserRecord } from '../db/usersRepo.js';

const require = createRequire(import.meta.url);
const { SamlLib } = require('samlify') as Pick<typeof import('samlify'), 'SamlLib'>;
// The shipped Emscripten validator adds process listeners on every invocation and
// logs raw schema diagnostics. Keep it off the request thread, capture its output,
// enforce a deadline and recycle workers after a bounded number of jobs. Workers
// receive XML only, never profile secrets or user records.
const schemaModule = require.resolve('@authenio/samlify-node-xmllint');
const validationSlots = new Map<string, number>();
let activeValidations = 0;
interface SchemaWorker { worker: Worker; jobs: number; idleTimer?: ReturnType<typeof setTimeout> }
const idleWorkers: SchemaWorker[] = [];
function newSchemaWorker(): SchemaWorker {
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const validator = require(workerData.schemaModule);
    parentPort.on('message', xml => {
      validator.validate(xml).then(() => parentPort.postMessage(true), () => parentPort.postMessage(false));
    });
  `, { eval: true, workerData: { schemaModule }, execArgv: [], stdout: true, stderr: true,
    resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } });
  worker.stdout.resume();
  worker.stderr.resume();
  // Idle failures must never become uncaught exceptions in the HTTP process.
  worker.on('error', () => undefined);
  return { worker, jobs: 0 };
}
async function validateSchema(xml: string, enterpriseId: string): Promise<void> {
  const current = validationSlots.get(enterpriseId) ?? 0;
  if (current >= 2 || activeValidations >= 8) throw new Error('saml_schema_capacity');
  validationSlots.set(enterpriseId, current + 1);
  activeValidations++;
  let entry: SchemaWorker | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  try {
    entry = idleWorkers.pop() ?? newSchemaWorker();
    clearTimeout(entry.idleTimer);
    const { worker } = entry;
    worker.ref();
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        worker.off('message', onMessage); worker.off('error', onError); worker.off('exit', onError);
        clearTimeout(timer);
      };
      const onMessage = (valid: unknown): void => {
        settled = true;
        cleanup();
        valid === true ? resolve() : reject(new Error('saml_xml_schema_invalid'));
      };
      const onError = (): void => { cleanup(); reject(new Error('saml_xml_schema_invalid')); };
      timer = setTimeout(onError, 5000);
      worker.once('message', onMessage); worker.once('error', onError); worker.once('exit', onError);
      worker.postMessage(xml);
    });
  } finally {
    clearTimeout(timer);
    if (entry) {
      if (!settled || ++entry.jobs >= 8) await entry.worker.terminate();
      else {
        const released = entry;
        released.worker.unref();
        released.idleTimer = setTimeout(() => {
          const index = idleWorkers.indexOf(released);
          if (index >= 0) { idleWorkers.splice(index, 1); void released.worker.terminate(); }
        }, 1000).unref();
        idleWorkers.push(released);
      }
    }
    activeValidations--;
    const remaining = (validationSlots.get(enterpriseId) ?? 1) - 1;
    if (remaining) validationSlots.set(enterpriseId, remaining); else validationSlots.delete(enterpriseId);
  }
}

const BINDING = {
  redirect: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect',
  post: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST',
} as const;

const NAMEID_FORMAT_PERSISTENT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent';
const PASSWORD_PROTECTED_TRANSPORT = 'urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport';
const STATUS_SUCCESS = 'urn:oasis:names:tc:SAML:2.0:status:Success';
const ATTR_FMT_BASIC = 'urn:oasis:names:tc:SAML:2.0:attrname-format:basic';
const XS = 'http://www.w3.org/2001/XMLSchema';
const XSI = 'http://www.w3.org/2001/XMLSchema-instance';

const PROTOCOL_NS = 'urn:oasis:names:tc:SAML:2.0:protocol';
const ASSERTION_NS = 'urn:oasis:names:tc:SAML:2.0:assertion';
const MAX_XML_BYTES = 64 * 1024;
const MAX_BASE64_BYTES = 96 * 1024;
const MAX_REQUEST_AGE_MS = 5 * 60 * 1000;
const CLOCK_SKEW_MS = 60 * 1000;
const MAX_CONTEXTS = 100;

const loginResponseTemplate =
  '<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="{ID}" Version="2.0" IssueInstant="{IssueInstant}" Destination="{Destination}" InResponseTo="{InResponseTo}">' +
  '<saml:Issuer>{Issuer}</saml:Issuer>' +
  '<samlp:Status><samlp:StatusCode Value="{StatusCode}"/></samlp:Status>' +
  `<saml:Assertion xmlns:xsi="${XSI}" xmlns:xs="${XS}" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="{AssertionID}" Version="2.0" IssueInstant="{IssueInstant}">` +
  '<saml:Issuer>{Issuer}</saml:Issuer>' +
  '<saml:Subject><saml:NameID Format="{NameIDFormat}">{NameID}</saml:NameID>' +
  '<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">' +
  '<saml:SubjectConfirmationData NotOnOrAfter="{SubjectConfirmationDataNotOnOrAfter}" Recipient="{SubjectRecipient}" InResponseTo="{InResponseTo}"/>' +
  '</saml:SubjectConfirmation></saml:Subject>' +
  '<saml:Conditions NotBefore="{ConditionsNotBefore}" NotOnOrAfter="{ConditionsNotOnOrAfter}">' +
  '<saml:AudienceRestriction><saml:Audience>{Audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions>' +
  '<saml:AuthnStatement AuthnInstant="{AuthnInstant}" SessionIndex="{SessionIndex}">' +
  `<saml:AuthnContext><saml:AuthnContextClassRef>${PASSWORD_PROTECTED_TRANSPORT}</saml:AuthnContextClassRef></saml:AuthnContext>` +
  '</saml:AuthnStatement>' +
  '<saml:AttributeStatement>' +
  `<saml:Attribute Name="username" NameFormat="${ATTR_FMT_BASIC}"><saml:AttributeValue xmlns:xs="${XS}" xmlns:xsi="${XSI}" xsi:type="xs:string">{attrUsername}</saml:AttributeValue></saml:Attribute>` +
  `<saml:Attribute Name="full_name" NameFormat="${ATTR_FMT_BASIC}"><saml:AttributeValue xmlns:xs="${XS}" xmlns:xsi="${XSI}" xsi:type="xs:string">{attrFullname}</saml:AttributeValue></saml:Attribute>` +
  `<saml:Attribute Name="emails" NameFormat="${ATTR_FMT_BASIC}"><saml:AttributeValue xmlns:xs="${XS}" xmlns:xsi="${XSI}" xsi:type="xs:string">{attrEmail}</saml:AttributeValue></saml:Attribute>` +
  '</saml:AttributeStatement>' +
  '</saml:Assertion></samlp:Response>';

export interface ParsedAuthnRequest {
  id: string;
  relayState?: string;
  forceAuthn: boolean;
}

export interface SamlPostResponse {
  acsUrl: string;
  samlResponse: string;
  relayState: string;
}

interface SamlContext {
  revision: number;
  registryRevision: number;
  profile: EnterpriseProfileV3;
  idp: ReturnType<typeof samlify.IdentityProvider>;
  sp: ReturnType<typeof samlify.ServiceProvider>;
}
const contexts = new Map<string, SamlContext>();

/** Only validated registry profiles may supply endpoints and secret references. */
function context(scope: EnterpriseScope): SamlContext {
  const profile = getScopeProfile(scope);
  const cached = contexts.get(scope.enterpriseId);
  if (cached?.revision === scope.enterpriseRevision && cached.registryRevision === scope.registryRevision) return cached;
  const signingCert = readEnterpriseSecret(profile.sso.signingCertRef);
  const privateKey = readEnterpriseSecret(profile.sso.signingKeyRef);
  const cert = new X509Certificate(signingCert);
  const key = createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 ||
    !cert.publicKey.export({ type: 'spki', format: 'der' }).equals(createPublicKey(key).export({ type: 'spki', format: 'der' }))) {
    throw new Error('saml_signing_key_invalid');
  }
  const idp = samlify.IdentityProvider({
    entityID: profile.sso.entityId,
    signingCert,
    privateKey,
    requestSignatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
    nameIDFormat: [NAMEID_FORMAT_PERSISTENT],
    singleSignOnService: [
      { Binding: BINDING.redirect, Location: profile.sso.ssoUrl },
      { Binding: BINDING.post, Location: profile.sso.ssoUrl },
    ],
    singleLogoutService: [{ Binding: BINDING.post, Location: profile.sso.logoutUrl }],
    // GitHub sends unsigned AuthnRequests. Issuer/ACS/destination are still mandatory below.
    wantAuthnRequestsSigned: false,
    loginResponseTemplate: { context: loginResponseTemplate, attributes: [] },
  });
  const sp = samlify.ServiceProvider({
    entityID: profile.sso.spEntityId,
    assertionConsumerService: [{ Binding: BINDING.post, Location: profile.sso.spAcsUrl }],
    nameIDFormat: [NAMEID_FORMAT_PERSISTENT],
    wantAssertionsSigned: true,
    wantMessageSigned: true,
    authnRequestsSigned: false,
  });
  const result = { revision: scope.enterpriseRevision, registryRevision: scope.registryRevision, profile, idp, sp };
  if (!cached && contexts.size >= MAX_CONTEXTS) contexts.delete(contexts.keys().next().value!);
  contexts.set(scope.enterpriseId, result);
  return result;
}

export function metadataXml(scope: EnterpriseScope): string {
  return context(scope).idp.getMetadata();
}

export async function parseAuthnRequest(parameters: Record<string, unknown>, binding: 'redirect' | 'post', scope: EnterpriseScope): Promise<ParsedAuthnRequest> {
  const { profile } = context(scope);
  if (binding !== 'redirect' && binding !== 'post') throw new Error('saml_binding_invalid');
  // Arrays/objects include duplicate and bracket-shaped parameters from Express parsers.
  for (const [key, value] of Object.entries(parameters)) {
    if (!['SAMLRequest', 'RelayState'].includes(key) || typeof value !== 'string') throw new Error('saml_parameter_invalid');
  }
  const encoded = parameters.SAMLRequest;
  if (typeof encoded !== 'string' || !encoded || encoded.length > MAX_BASE64_BYTES ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error('saml_encoding_invalid');
  const relayState = parameters.RelayState as string | undefined;
  if (relayState !== undefined && (Buffer.byteLength(relayState) > 80 || /[\x00-\x1f\x7f]/u.test(relayState))) throw new Error('saml_relay_state_invalid');
  const bytes = Buffer.from(encoded, 'base64');
  const decoded = binding === 'redirect' ? inflateRawSync(bytes, { maxOutputLength: MAX_XML_BYTES }) : bytes;
  if (decoded.length > MAX_XML_BYTES) throw new Error('saml_xml_too_large');
  const xml = new TextDecoder('utf-8', { fatal: true }).decode(decoded);
  // These are deny rules, not XML parsing. No DTD, custom entity, or PI reaches libxml.
  if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(xml) || /<\?(?!xml\s)/i.test(xml) || /\x00/.test(xml)) throw new Error('saml_xml_forbidden');
  let invalid = false;
  const document = new DOMParser({ errorHandler: { warning: () => { invalid = true; }, error: () => { invalid = true; }, fatalError: () => { invalid = true; } } }).parseFromString(xml, 'text/xml');
  const root = document.documentElement;
  if (invalid || !root || document.doctype || root.namespaceURI !== PROTOCOL_NS || root.localName !== 'AuthnRequest') throw new Error('saml_xml_invalid');
  // Bound depth/node count before invoking the schema engine; reject nested request wrappers.
  const stack = [{ node: root, depth: 1 }];
  let elements = 0;
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    if (++elements > 256 || depth > 16) throw new Error('saml_xml_complexity');
    if (node !== root && (node.localName === 'AuthnRequest' || node.hasAttribute('ID'))) throw new Error('saml_xml_ambiguous');
    if (node.namespaceURI === 'http://www.w3.org/2000/09/xmldsig#' || node.localName === 'Extensions') throw new Error('saml_request_unsupported');
    for (let child = node.firstChild; child; child = child.nextSibling) if (child.nodeType === 1) stack.push({ node: child as typeof root, depth: depth + 1 });
  }
  await validateSchema(xml, scope.enterpriseId);
  // Schema permits optional endpoint/issuer fields: this deployment deliberately does not.
  const id = root.getAttribute('ID') ?? '';
  const issueInstant = root.getAttribute('IssueInstant') ?? '';
  const issuedAt = Date.parse(issueInstant);
  const issuers = root.getElementsByTagNameNS(ASSERTION_NS, 'Issuer');
  if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,255}$/.test(id) || root.getAttribute('Version') !== '2.0' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(issueInstant) || !Number.isFinite(issuedAt) ||
    issuedAt < Date.now() - MAX_REQUEST_AGE_MS || issuedAt > Date.now() + CLOCK_SKEW_MS ||
    issuers.length !== 1 || issuers[0]!.parentNode !== root || issuers[0]!.textContent !== profile.sso.spEntityId ||
    root.getAttribute('Destination') !== profile.sso.ssoUrl || root.getAttribute('AssertionConsumerServiceURL') !== profile.sso.spAcsUrl ||
    root.getAttribute('ProtocolBinding') !== BINDING.post || root.hasAttribute('AssertionConsumerServiceIndex') ||
    root.hasAttribute('AttributeConsumingServiceIndex') || ['true', '1'].includes(root.getAttribute('IsPassive') ?? '')) throw new Error('saml_request_invalid');
  if (root.getElementsByTagNameNS(ASSERTION_NS, 'Subject').length || root.getElementsByTagNameNS(ASSERTION_NS, 'Conditions').length || root.getElementsByTagNameNS(PROTOCOL_NS, 'Scoping').length) throw new Error('saml_request_unsupported');
  // We assert only password authentication over protected transport. Never claim
  // a stronger class or invent an ordering for minimum/maximum/better requests.
  const requestedContexts = root.getElementsByTagNameNS('*', 'RequestedAuthnContext');
  if (requestedContexts.length) {
    const requested = requestedContexts[0]!;
    const classes = requested.getElementsByTagNameNS('*', 'AuthnContextClassRef');
    const children = Array.from(requested.childNodes).filter(child => child.nodeType === 1);
    if (requestedContexts.length !== 1 || requested.namespaceURI !== PROTOCOL_NS || requested.parentNode !== root
      || requested.hasAttribute('Comparison') && requested.getAttribute('Comparison') !== 'exact'
      || classes.length !== 1 || children.length !== 1 || classes[0]!.parentNode !== requested
      || classes[0]!.namespaceURI !== ASSERTION_NS || classes[0]!.textContent !== PASSWORD_PROTECTED_TRANSPORT
      || Array.from(classes[0]!.childNodes).some(child => child.nodeType === 1)) throw new Error('saml_request_unsupported');
  }
  const policies = root.getElementsByTagNameNS(PROTOCOL_NS, 'NameIDPolicy');
  if (policies.length && ((policies[0]!.getAttribute('Format') && policies[0]!.getAttribute('Format') !== NAMEID_FORMAT_PERSISTENT) ||
    (policies[0]!.hasAttribute('SPNameQualifier') && policies[0]!.getAttribute('SPNameQualifier') !== profile.sso.spEntityId))) throw new Error('saml_request_unsupported');
  getScopeProfile(scope); // Recheck revision after asynchronous schema validation.
  return { id, relayState, forceAuthn: ['true', '1'].includes(root.getAttribute('ForceAuthn') ?? '') };
}

export async function buildSamlResponse(user: SsoUserRecord, inResponseTo: string, relayState: string | undefined, scope: EnterpriseScope): Promise<SamlPostResponse> {
  if (user.enterpriseId !== scope.enterpriseId || !user.userIncarnation || !/^[A-Za-z_][A-Za-z0-9_.-]{0,255}$/.test(inResponseTo)) throw new Error('saml_user_or_request_invalid');
  const { idp, sp, profile } = context(scope);
  const requestInfo = { extract: { request: { id: inResponseTo } } };
  const result = await idp.createLoginResponse(sp, requestInfo as never, 'post', { email: user.ssoUser }, (template: string) => {
    const responseId = `_${randomUUID()}`;
    const assertionId = `_${randomUUID()}`;
    const now = new Date();
    const notOnOrAfter = new Date(now.getTime() + 5 * 60 * 1000);
    const values: Record<string, string> = {
      ID: responseId,
      AssertionID: assertionId,
      Issuer: profile.sso.entityId,
      Audience: profile.sso.spEntityId,
      Destination: profile.sso.spAcsUrl,
      SubjectRecipient: profile.sso.spAcsUrl,
      StatusCode: STATUS_SUCCESS,
      NameIDFormat: NAMEID_FORMAT_PERSISTENT,
      NameID: user.ssoUser,
      IssueInstant: now.toISOString(),
      ConditionsNotBefore: new Date(now.getTime() - CLOCK_SKEW_MS).toISOString(),
      ConditionsNotOnOrAfter: notOnOrAfter.toISOString(),
      SubjectConfirmationDataNotOnOrAfter: notOnOrAfter.toISOString(),
      AuthnInstant: now.toISOString(),
      SessionIndex: responseId,
      InResponseTo: inResponseTo,
      attrUsername: user.ssoUser,
      attrFullname: user.ssoUser,
      attrEmail: user.email,
    };
    return { id: responseId, context: SamlLib.replaceTagsByValue(template, values) };
  });
  getScopeProfile(scope);
  const post = result as unknown as { context: string; entityEndpoint?: string };
  if (post.entityEndpoint && post.entityEndpoint !== profile.sso.spAcsUrl) throw new Error('saml_response_endpoint_invalid');
  return { acsUrl: profile.sso.spAcsUrl, samlResponse: post.context, relayState: relayState ?? '' };
}
