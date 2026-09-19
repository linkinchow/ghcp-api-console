import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { redactFields } from '@ghcp/shared';

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export class AccountLogger {
  private constructor(
    private readonly accountName: string,
    private readonly filePath: string,
    private readonly debugEnabled: boolean,
  ) {}

  static create(logDir: string, accountName: string, debugEnabled: boolean): AccountLogger {
    const bucket = createHash('sha256').update(accountName).digest('hex').slice(0, 2);
    const dir = join(logDir, bucket);
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, `${sanitizeFileName(accountName)}.log`);
    const logger = new AccountLogger(accountName, filePath, debugEnabled);
    writeLine(filePath, 'w', logger.format('info', 'start', 'Starting login task log', { accountName }));
    return logger;
  }

  static createTask(logDir: string, scope: {enterpriseId:string;taskId:string;oauthAttemptId:string},debugEnabled: boolean): AccountLogger {
    const dir = join(logDir,...[scope.enterpriseId,scope.taskId,scope.oauthAttemptId].map(pathSegment));
    mkdirSync(dir,{recursive:true});
    const filePath = join(dir,'task.log');
    const logger = new AccountLogger(scope.taskId,filePath,debugEnabled);
    writeLine(filePath,'a',logger.format('info','start','Starting login task log',scope));
    return logger;
  }

  get path(): string {
    return this.filePath;
  }

  info(step: string, message: string, fields?: Record<string, unknown>): void {
    this.write('info', step, message, fields);
  }

  warn(step: string, message: string, fields?: Record<string, unknown>): void {
    this.write('warn', step, message, fields);
  }

  error(step: string, message: string, fields?: Record<string, unknown>): void {
    this.write('error', step, message, fields);
  }

  debug(step: string, message: string, fields?: Record<string, unknown>): void {
    if (this.debugEnabled) this.write('debug', step, message, fields);
  }

  private write(level: LogLevel, step: string, message: string, fields?: Record<string, unknown>): void {
    writeLine(this.filePath, 'a', this.format(level, step, message, fields));
  }

  private format(level: LogLevel, step: string, message: string, fields?: Record<string, unknown>): string {
    const suffix = fields ? ` ${JSON.stringify(redactFields(fields))}` : '';
    return `${new Date().toISOString()} [${this.accountName}] ${level.toUpperCase()} ${step}: ${message}${suffix}\n`;
  }
}

export function pathSegment(value: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error('invalid_artifact_scope');
  return value;
}

function sanitizeFileName(name: string): string {
  return name.trim().replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'account';
}

function writeLine(filePath: string, flag: 'a' | 'w', line: string): void {
  const fd = openSync(filePath, flag);
  try {
    writeSync(fd, line);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
