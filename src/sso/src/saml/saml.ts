import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { DOMParser } from '@xmldom/xmldom';
import * as samlify from 'samlify';
import type { EnterpriseId } from '@ghcp/shared';
import { config } from '../config.js';
import type { SsoUserRecord } from '../db/usersRepo.js';
import type { SsoEnterprise } from '../enterprises.js';
import { requireSsoSecret } from '../enterpriseSecrets.js';
import { validateSamlXml } from './xmlValidator.js';

const require = createRequire(import.meta.url);
const { SamlLib } = require('samlify') as Pick<typeof import('samlify'), 'SamlLib'>;
samlify.setSchemaValidator({ validate: validateSamlXml });

const BINDING = {
  redirect: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect',
  post: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST',
} as const;

const NAMEID_FORMAT_PERSISTENT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent';
const STATUS_SUCCESS = 'urn:oasis:names:tc:SAML:2.0:status:Success';
const ATTR_FMT_BASIC = 'urn:oasis:names:tc:SAML:2.0:attrname-format:basic';
const ASSERTION_NS = 'urn:oasis:names:tc:SAML:2.0:assertion';
const XS = 'http://www.w3.org/2001/XMLSchema';
const XSI = 'http://www.w3.org/2001/XMLSchema-instance';
const ELEMENT_NODE = 1;
const MAX_REQUEST_XML_BYTES = 64 * 1024;
/** SAML IDs are xs:ID values (NCNames); they are echoed into the signed response as InResponseTo. */
const SAML_ID = /^[A-Za-z_][\w.-]{0,255}$/;

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
  '<saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext>' +
  '</saml:AuthnStatement>' +
  '<saml:AttributeStatement>' +
  `<saml:Attribute Name="username" NameFormat="${ATTR_FMT_BASIC}"><saml:AttributeValue xmlns:xs="${XS}" xmlns:xsi="${XSI}" xsi:type="xs:string">{attrUsername}</saml:AttributeValue></saml:Attribute>` +
  `<saml:Attribute Name="full_name" NameFormat="${ATTR_FMT_BASIC}"><saml:AttributeValue xmlns:xs="${XS}" xmlns:xsi="${XSI}" xsi:type="xs:string">{attrFullname}</saml:AttributeValue></saml:Attribute>` +
  `<saml:Attribute Name="emails" NameFormat="${ATTR_FMT_BASIC}"><saml:AttributeValue xmlns:xs="${XS}" xmlns:xsi="${XSI}" xsi:type="xs:string">{attrEmail}</saml:AttributeValue></saml:Attribute>` +
  '</saml:AttributeStatement>' +
  '</saml:Assertion></samlp:Response>';

export interface ParsedAuthnRequest {
  id?: string;
  relayState?: string;
  forceAuthn?: boolean;
}

export interface SamlPostResponse {
  acsUrl: string;
  samlResponse: string;
  relayState: string;
}

/** The SAML identities of one enterprise: this IdP's endpoints and the GitHub service provider. */
export interface SamlUrls {
  idpEntityId: string;
  idpSsoUrl: string;
  idpLogoutUrl: string;
  spEntityId: string;
  spAcsUrl: string;
}

interface SamlContext {
  urls: SamlUrls;
  idp: ReturnType<typeof samlify.IdentityProvider>;
  sp: ReturnType<typeof samlify.ServiceProvider>;
}

interface AuthnRequestFields {
  id: string | undefined;
  issuers: string[];
  destination: string | undefined;
  acsUrl: string | undefined;
  forceAuthn: boolean | undefined;
}

/** The registry does not hot-reload (design §3.7), so each enterprise's IdP/SP pair is built once. */
const contexts = new Map<EnterpriseId, SamlContext>();

/** `default` keeps the baseline root URLs; other enterprises live under `/enterprises/<id>`. */
export function samlUrls(enterprise: SsoEnterprise): SamlUrls {
  const idpBase = `${config.baseUrl}${enterprise.publicPath}`;
  return {
    idpEntityId: `${idpBase}/metadata`,
    idpSsoUrl: `${idpBase}/sso`,
    idpLogoutUrl: `${idpBase}/logout`,
    spEntityId: requireEndpoint(enterprise, 'spEntityId'),
    spAcsUrl: requireEndpoint(enterprise, 'spAcsUrl'),
  };
}

export function metadataXml(enterprise: SsoEnterprise): string {
  return samlContext(enterprise).idp.getMetadata();
}

/** Parses an HTTP-Redirect AuthnRequest and checks it was addressed by this enterprise's SP to this IdP. */
export async function parseAuthnRequest(
  enterprise: SsoEnterprise,
  query: Record<string, unknown>,
): Promise<ParsedAuthnRequest> {
  const { urls } = samlContext(enterprise);
  const xml = decodeRedirectRequest(query.SAMLRequest);
  await validateSamlXml(xml);
  const request = readAuthnRequest(xml);
  assertRequestMatches(request, urls);
  return {
    id: request.id,
    relayState: typeof query.RelayState === 'string' ? query.RelayState : undefined,
    forceAuthn: request.forceAuthn,
  };
}

export async function buildSamlResponse(
  enterprise: SsoEnterprise,
  user: SsoUserRecord,
  inResponseTo?: string,
  relayState?: string,
): Promise<SamlPostResponse> {
  const { idp, sp, urls } = samlContext(enterprise);
  const requestInfo = inResponseTo ? { extract: { request: { id: inResponseTo } } } : { extract: {} };
  const fill = (template: string) => fillResponseTemplate(template, urls, user, inResponseTo);
  const result = await idp.createLoginResponse(sp, requestInfo as never, 'post', { email: user.ssoUser }, fill);
  const post = result as unknown as { context: string; entityEndpoint?: string };
  return { acsUrl: post.entityEndpoint ?? urls.spAcsUrl, samlResponse: post.context, relayState: relayState ?? '' };
}

function fillResponseTemplate(
  template: string,
  urls: SamlUrls,
  user: SsoUserRecord,
  inResponseTo: string | undefined,
): { id: string; context: string } {
  const responseId = `_${randomUUID()}`;
  const now = new Date();
  const notOnOrAfter = new Date(now.getTime() + 5 * 60 * 1000);
  const values: Record<string, string | undefined> = {
    ID: responseId,
    AssertionID: `_${randomUUID()}`,
    Issuer: urls.idpEntityId,
    Audience: urls.spEntityId,
    Destination: urls.spAcsUrl,
    SubjectRecipient: urls.spAcsUrl,
    StatusCode: STATUS_SUCCESS,
    NameIDFormat: NAMEID_FORMAT_PERSISTENT,
    NameID: user.ssoUser,
    IssueInstant: now.toISOString(),
    ConditionsNotBefore: now.toISOString(),
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
}

function samlContext(enterprise: SsoEnterprise): SamlContext {
  let context = contexts.get(enterprise.id);
  if (!context) {
    context = createSamlContext(enterprise);
    contexts.set(enterprise.id, context);
  }
  return context;
}

function createSamlContext(enterprise: SsoEnterprise): SamlContext {
  const urls = samlUrls(enterprise);
  const idp = samlify.IdentityProvider({
    entityID: urls.idpEntityId,
    signingCert: requireSsoSecret(enterprise, 'signingCert'),
    privateKey: requireSsoSecret(enterprise, 'signingKey'),
    nameIDFormat: [NAMEID_FORMAT_PERSISTENT],
    singleSignOnService: [
      { Binding: BINDING.redirect, Location: urls.idpSsoUrl },
      { Binding: BINDING.post, Location: urls.idpSsoUrl },
    ],
    singleLogoutService: [{ Binding: BINDING.post, Location: urls.idpLogoutUrl }],
    wantAuthnRequestsSigned: false,
    loginResponseTemplate: { context: loginResponseTemplate, attributes: [] },
  });
  const sp = samlify.ServiceProvider({
    entityID: urls.spEntityId,
    assertionConsumerService: [{ Binding: BINDING.post, Location: urls.spAcsUrl }],
    nameIDFormat: [NAMEID_FORMAT_PERSISTENT],
    wantAssertionsSigned: true,
    authnRequestsSigned: false,
  });
  return { urls, idp, sp };
}

function decodeRedirectRequest(encoded: unknown): string {
  if (typeof encoded !== 'string' || !encoded) throw new Error('SAMLRequest is required.');
  const deflated = Buffer.from(encoded, 'base64');
  return inflateRawSync(deflated, { maxOutputLength: MAX_REQUEST_XML_BYTES }).toString('utf8');
}

function readAuthnRequest(xml: string): AuthnRequestFields {
  const root = new DOMParser().parseFromString(xml, 'text/xml').documentElement!;
  const issuers = Array.from(root.childNodes)
    .filter((node): node is Element => node.nodeType === ELEMENT_NODE)
    .filter((element) => element.namespaceURI === ASSERTION_NS && element.localName === 'Issuer')
    .map((element) => element.textContent?.trim() ?? '');
  return {
    id: optionalAttribute(root, 'ID'),
    issuers,
    destination: optionalAttribute(root, 'Destination'),
    acsUrl: optionalAttribute(root, 'AssertionConsumerServiceURL'),
    forceAuthn: parseBoolean(optionalAttribute(root, 'ForceAuthn')),
  };
}

function assertRequestMatches(request: AuthnRequestFields, urls: SamlUrls): void {
  if (request.id !== undefined && !SAML_ID.test(request.id)) throw new Error('AuthnRequest ID is not a valid SAML ID.');
  if (request.issuers.length !== 1 || request.issuers[0] !== urls.spEntityId) {
    throw new Error('AuthnRequest Issuer does not match the service provider.');
  }
  if (request.destination !== undefined && request.destination !== urls.idpSsoUrl) {
    throw new Error('AuthnRequest Destination does not match this identity provider.');
  }
  if (request.acsUrl !== undefined && request.acsUrl !== urls.spAcsUrl) {
    throw new Error('AuthnRequest AssertionConsumerServiceURL does not match the service provider.');
  }
}

function optionalAttribute(element: Element, name: string): string | undefined {
  return element.hasAttribute(name) ? element.getAttribute(name) ?? undefined : undefined;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized === 'true' || normalized === '1';
}

function requireEndpoint(enterprise: SsoEnterprise, field: 'spEntityId' | 'spAcsUrl'): string {
  const value = enterprise.endpoints[field];
  if (!value) throw new Error(`${enterprise.id}.sso.${field} is not configured.`);
  return value;
}
