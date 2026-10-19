import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  type FileMemoryConfig,
  type ViewOptions,
  type CreateOptions,
  type StrReplaceOptions,
  type RenameOptions,
  type MemoryToolInput,
  type MemoryToolResult,
  MemorySecurityError,
  MemoryNotFoundError,
  MemoryConflictError,
  MemoryValidationError,
  memoryToolInputSchema,
} from './types.js';

export class FileMemoryEngine {
  readonly rootDir: string;
  readonly defaultOverwrite: boolean;
  readonly maxFileSize: number;
  private canonicalRootDir: string | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(config?: FileMemoryConfig) {
    this.rootDir = path.resolve(config?.rootDir ?? './work/memories');
    this.defaultOverwrite = config?.defaultOverwrite ?? false;
    this.maxFileSize = config?.maxFileSize ?? 10 * 1024 * 1024;
  }

  async init(): Promise<void> {
    if (this.canonicalRootDir) return;
    if (!this.initPromise) {
      this.initPromise = (async () => {
        await fs.promises.mkdir(this.rootDir, { recursive: true });
        this.canonicalRootDir = await fs.promises.realpath(this.rootDir);
      })();
    }
    return this.initPromise;
  }

  /**
   * Resolves a sandboxed path. Enforces:
   * 1. Path must begin with '/memories' (or '/memories/')
   * 2. No null byte injection
   * 3. No relative .. segments or traversal outside sandbox
   * 4. No symlink escapes
   */
  async resolveSandboxedPath(sandboxedPath: string): Promise<string> {
    await this.init();
    if (!this.canonicalRootDir) {
      throw new Error('Memory engine failed to initialize root directory');
    }

    if (typeof sandboxedPath !== 'string' || !sandboxedPath.trim()) {
      throw new MemorySecurityError("Path must start with '/memories'");
    }

    // Check null byte
    if (sandboxedPath.includes('\0') || sandboxedPath.includes('%00') || sandboxedPath.includes('\u0000')) {
      throw new MemorySecurityError('Null byte detected in path');
    }

    // Decode URL-encoded segments
    let decoded = sandboxedPath;
    try {
      while (decoded.includes('%')) {
        const next = decodeURIComponent(decoded);
        if (next === decoded) break;
        decoded = next;
      }
    } catch {
      throw new MemorySecurityError('Invalid URL encoding in path');
    }

    if (decoded !== '/memories' && !decoded.startsWith('/memories/')) {
      throw new MemorySecurityError("Path must start with '/memories'");
    }

    const segments = decoded.split(/[/\\]+/);
    if (segments.includes('..')) {
      throw new MemorySecurityError('Path traversal detected');
    }

    const sub = decoded.slice('/memories'.length).replace(/^[/\\]+/, '');
    const normalized = path.normalize(sub);

    if (normalized === '..' || normalized.startsWith('..' + path.sep) || normalized.includes(path.sep + '..' + path.sep)) {
      throw new MemorySecurityError('Path traversal detected');
    }

    const full = path.resolve(this.canonicalRootDir, normalized);
    if (full !== this.canonicalRootDir && !full.startsWith(this.canonicalRootDir + path.sep)) {
      throw new MemorySecurityError('Path escapes sandbox');
    }

    // Check symlink escapes for the target and all its ancestors
    let curr = full;
    while (curr && curr.length >= this.canonicalRootDir.length) {
      if (fs.existsSync(curr)) {
        const real = await fs.promises.realpath(curr);
        if (real !== this.canonicalRootDir && !real.startsWith(this.canonicalRootDir + path.sep)) {
          throw new MemorySecurityError('Symlink target escapes sandbox');
        }
      }
      const parent = path.dirname(curr);
      if (parent === curr) break;
      curr = parent;
    }

    return full;
  }

  async exists(sandboxedPath: string): Promise<boolean> {
    try {
      const resolved = await this.resolveSandboxedPath(sandboxedPath);
      return fs.existsSync(resolved);
    } catch {
      return false;
    }
  }

  async view(sandboxedPath: string, options?: ViewOptions): Promise<string> {
    const resolved = await this.resolveSandboxedPath(sandboxedPath);
    if (!fs.existsSync(resolved)) {
      throw new MemoryNotFoundError(`File or directory not found: ${sandboxedPath}`);
    }

    const stat = await fs.promises.stat(resolved);
    if (stat.isDirectory()) {
      const entries = await fs.promises.readdir(resolved, { withFileTypes: true });
      if (entries.length === 0) {
        return '(empty directory)';
      }
      const names = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort();
      return names.join('\n');
    }

    const raw = await fs.promises.readFile(resolved, 'utf-8');
    if (options?.viewRange) {
      const [start, end] = options.viewRange;
      if (start < 1) {
        throw new MemoryValidationError(`Invalid start line: ${start}`);
      }
      if (end < start) {
        throw new MemoryValidationError(`Invalid view range: start (${start}) > end (${end})`);
      }
      const lines = raw.split(/\r?\n/);
      return lines.slice(start - 1, end).join('\n');
    }

    return raw;
  }

  async create(sandboxedPath: string, content?: string, options?: CreateOptions): Promise<string> {
    const resolved = await this.resolveSandboxedPath(sandboxedPath);
    if (resolved === this.canonicalRootDir) {
      throw new MemoryValidationError('Cannot create sandbox root directory');
    }

    const exists = fs.existsSync(resolved);
    const overwrite = options?.overwrite ?? this.defaultOverwrite;

    if (content === undefined) {
      // Create directory
      await fs.promises.mkdir(resolved, { recursive: true });
      return `Successfully created directory: ${sandboxedPath}`;
    }

    if (exists && !overwrite) {
      throw new MemoryConflictError(`File already exists: ${sandboxedPath}`);
    }

    const buffer = Buffer.from(content, 'utf-8');
    if (buffer.length > this.maxFileSize) {
      throw new MemoryValidationError(`File size exceeds max limit: ${this.maxFileSize}`);
    }

    await fs.promises.mkdir(path.dirname(resolved), { recursive: true });
    await fs.promises.writeFile(resolved, content, 'utf-8');
    return `Successfully created file: ${sandboxedPath}`;
  }

  async str_replace(
    sandboxedPath: string,
    oldStr: string,
    newStr: string,
    options?: StrReplaceOptions,
  ): Promise<string> {
    if (!oldStr) {
      throw new MemoryValidationError('oldStr cannot be empty');
    }

    const resolved = await this.resolveSandboxedPath(sandboxedPath);
    if (!fs.existsSync(resolved)) {
      throw new MemoryNotFoundError(`File not found: ${sandboxedPath}`);
    }

    const stat = await fs.promises.stat(resolved);
    if (stat.isDirectory()) {
      throw new MemoryValidationError(`Cannot perform str_replace on a directory: ${sandboxedPath}`);
    }

    const current = await fs.promises.readFile(resolved, 'utf-8');
    if (!current.includes(oldStr)) {
      throw new MemoryNotFoundError(`String not found in file: ${oldStr}`);
    }

    const occurrences = current.split(oldStr).length - 1;
    if (options?.index !== undefined) {
      const idx = options.index;
      if (idx < 0 || idx >= occurrences) {
        throw new MemoryValidationError(`Occurrence index out of bounds: ${idx}`);
      }

      const parts = current.split(oldStr);
      let reconstructed = '';
      for (let i = 0; i < parts.length; i++) {
        reconstructed += parts[i];
        if (i < parts.length - 1) {
          if (i === idx) {
            reconstructed += newStr;
          } else {
            reconstructed += oldStr;
          }
        }
      }
      await fs.promises.writeFile(resolved, reconstructed, 'utf-8');
      return `Successfully replaced string in ${sandboxedPath}`;
    }

    if (occurrences > 1) {
      throw new MemoryConflictError(
        `Multiple occurrences (${occurrences}) of oldStr found. Please specify index.`
      );
    }

    const updated = current.replace(oldStr, newStr);
    await fs.promises.writeFile(resolved, updated, 'utf-8');
    return `Successfully replaced string in ${sandboxedPath}`;
  }

  async insert(sandboxedPath: string, line: number, text: string): Promise<string> {
    const resolved = await this.resolveSandboxedPath(sandboxedPath);
    if (!fs.existsSync(resolved)) {
      throw new MemoryNotFoundError(`File not found: ${sandboxedPath}`);
    }

    const stat = await fs.promises.stat(resolved);
    if (stat.isDirectory()) {
      throw new MemoryValidationError(`Cannot insert into directory: ${sandboxedPath}`);
    }

    const current = await fs.promises.readFile(resolved, 'utf-8');
    const lines = current === '' ? [] : current.split(/\r?\n/);

    if (line < 1 || line > lines.length + 1) {
      throw new MemoryValidationError(
        `Insert line ${line} is out of bounds (file has ${lines.length} lines)`
      );
    }

    lines.splice(line - 1, 0, text);
    await fs.promises.writeFile(resolved, lines.join('\n'), 'utf-8');
    return `Successfully inserted text into ${sandboxedPath}`;
  }

  async delete(sandboxedPath: string): Promise<string> {
    const resolved = await this.resolveSandboxedPath(sandboxedPath);
    if (resolved === this.canonicalRootDir) {
      throw new MemorySecurityError('Cannot delete sandbox root');
    }

    if (!fs.existsSync(resolved)) {
      throw new MemoryNotFoundError(`File or directory not found: ${sandboxedPath}`);
    }

    const stat = await fs.promises.stat(resolved);
    if (stat.isDirectory()) {
      await fs.promises.rm(resolved, { recursive: true, force: true });
      return `Successfully deleted directory: ${sandboxedPath}`;
    }

    await fs.promises.unlink(resolved);
    return `Successfully deleted file: ${sandboxedPath}`;
  }

  async rename(oldPath: string, newPath: string, options?: RenameOptions): Promise<string> {
    const oldResolved = await this.resolveSandboxedPath(oldPath);
    const newResolved = await this.resolveSandboxedPath(newPath);

    if (oldResolved === this.canonicalRootDir || newResolved === this.canonicalRootDir) {
      throw new MemorySecurityError('Cannot rename sandbox root');
    }

    if (!fs.existsSync(oldResolved)) {
      throw new MemoryNotFoundError(`Source path not found: ${oldPath}`);
    }

    const overwrite = options?.overwrite ?? false;
    if (fs.existsSync(newResolved) && !overwrite) {
      throw new MemoryConflictError(`Destination path already exists: ${newPath}`);
    }

    await fs.promises.mkdir(path.dirname(newResolved), { recursive: true });
    await fs.promises.rename(oldResolved, newResolved);
    return `Successfully renamed "${oldPath}" to "${newPath}"`;
  }
}

export const memoryToolDefinition = {
  name: 'memory',
  type: 'memory_20250818',
  description: 'Manage persistent file memory in /memories sandbox.',
  input_schema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        enum: ['view', 'create', 'str_replace', 'insert', 'delete', 'rename'],
      },
    },
    required: ['command'],
  },
};

export async function executeMemoryTool(
  engine: FileMemoryEngine,
  input: MemoryToolInput,
): Promise<MemoryToolResult> {
  const parsed = memoryToolInputSchema.safeParse(input);
  if (!parsed.success) {
    const err = parsed.error.issues.map((i) => i.message).join('; ');
    return {
      success: false,
      content: err,
      is_error: true,
      error: err,
      toString() {
        return err;
      },
    };
  }

  const d = parsed.data;

  try {
    let content = '';
    const p = d.path ?? '';

    switch (d.command) {
      case 'view': {
        const vr = d.viewRange ?? d.view_range;
        content = await engine.view(p, vr ? { viewRange: vr } : undefined);
        break;
      }
      case 'create': {
        const text = d.content ?? d.file_text;
        content = await engine.create(p, text);
        break;
      }
      case 'str_replace': {
        const oldStr = d.oldStr ?? d.old_str ?? '';
        const newStr = d.newStr ?? d.new_str ?? '';
        content = await engine.str_replace(p, oldStr, newStr, { index: d.index });
        break;
      }
      case 'insert': {
        const line = d.insert_line !== undefined ? d.insert_line + 1 : (d.line ?? 1);
        const text = d.text ?? d.insert_text ?? d.content ?? '';
        content = await engine.insert(p, line, text);
        break;
      }
      case 'delete': {
        content = await engine.delete(p);
        break;
      }
      case 'rename': {
        const oldP = d.oldPath ?? d.old_path ?? p;
        const newP = d.newPath ?? d.new_path ?? '';
        content = await engine.rename(oldP, newP);
        break;
      }
    }

    return {
      success: true,
      content,
      is_error: false,
      toString() {
        return content;
      },
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      content: msg,
      is_error: true,
      error: msg,
      toString() {
        return msg;
      },
    };
  }
}

export function createMemoryToolExecutor(engine: FileMemoryEngine) {
  return (input: MemoryToolInput) => executeMemoryTool(engine, input);
}
