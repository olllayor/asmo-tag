import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  FileMemoryEngine,
  memoryToolDefinition,
  executeMemoryTool,
  createMemoryToolExecutor,
} from '../../src/memory/file-memory.js';
import {
  MemorySecurityError,
  MemoryNotFoundError,
  MemoryConflictError,
  MemoryValidationError,
} from '../../src/memory/types.js';

describe('FileMemoryEngine', () => {
  let tempDir: string;
  let engine: FileMemoryEngine;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'asmo-file-memory-'));
    engine = new FileMemoryEngine({ rootDir: tempDir });
    await engine.init();
  });

  afterEach(async () => {
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe('Strict Sandbox Containment & Security Boundaries', () => {
    it('rejects paths that do not start with /memories', async () => {
      const invalidPaths = [
        'notes.md',
        './notes.md',
        '/etc/passwd',
        '/var/log/syslog',
        '/memories_leak/file.txt',
        '/memory/notes.md',
        'C:\\Windows\\System32',
        '',
        '   ',
      ];

      for (const p of invalidPaths) {
        await expect(engine.resolveSandboxedPath(p)).rejects.toThrow(MemorySecurityError);
        await expect(engine.view(p)).rejects.toThrow(MemorySecurityError);
        await expect(engine.create(p, 'content')).rejects.toThrow(MemorySecurityError);
        await expect(engine.delete(p)).rejects.toThrow(MemorySecurityError);
      }
    });

    it('rejects directory traversal attacks using relative .. segments', async () => {
      const traversalPaths = [
        '/memories/../outside.txt',
        '/memories/../../../../etc/passwd',
        '/memories/sub/../../outside.txt',
        '/memories/sub/nested/../../../escape.txt',
        '/memories/foo/..',
      ];

      for (const p of traversalPaths) {
        await expect(engine.resolveSandboxedPath(p)).rejects.toThrow(MemorySecurityError);
        await expect(engine.view(p)).rejects.toThrow(MemorySecurityError);
        await expect(engine.create(p, 'evil')).rejects.toThrow(MemorySecurityError);
      }
    });

    it('rejects URL-encoded traversal attacks', async () => {
      const encodedPaths = [
        '/memories/%2e%2e/outside.txt',
        '/memories/%2e%2e%2foutside.txt',
        '/memories/sub/%2e%2e/%2e%2e/outside.txt',
        '/memories/%252e%252e/double-encoded.txt',
        '/memories/..%2f',
      ];

      for (const p of encodedPaths) {
        await expect(engine.resolveSandboxedPath(p)).rejects.toThrow(MemorySecurityError);
      }
    });

    it('rejects null byte injections', async () => {
      const nullBytePaths = [
        '/memories/file.txt\0.png',
        '/memories/file.txt%00.png',
        '/memories/dir\u0000/notes.txt',
      ];

      for (const p of nullBytePaths) {
        await expect(engine.resolveSandboxedPath(p)).rejects.toThrow(MemorySecurityError);
      }
    });

    it('prevents deleting or renaming the sandbox root /memories', async () => {
      await expect(engine.delete('/memories')).rejects.toThrow(MemorySecurityError);
      await expect(engine.delete('/memories/')).rejects.toThrow(MemorySecurityError);
      await expect(engine.rename('/memories', '/memories/renamed')).rejects.toThrow(
        MemorySecurityError
      );
      await expect(engine.rename('/memories/notes.md', '/memories')).rejects.toThrow(
        MemorySecurityError
      );
      await expect(engine.create('/memories')).rejects.toThrow(MemoryValidationError);
    });

    it('blocks symlink escapes pointing outside rootDir', async () => {
      // Create an outside secret file
      const outsideDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'asmo-outside-'));
      const outsideFile = path.join(outsideDir, 'secret.key');
      await fs.promises.writeFile(outsideFile, 'SUPER_SECRET', 'utf-8');

      // Create a symlink inside the sandbox pointing to the outside directory
      const symlinkPath = path.join(tempDir, 'leak_link');
      await fs.promises.symlink(outsideDir, symlinkPath);

      // Attempting to read through the symlink inside /memories must be rejected
      await expect(engine.view('/memories/leak_link/secret.key')).rejects.toThrow(
        MemorySecurityError
      );
      await expect(
        engine.create('/memories/leak_link/hacked.txt', 'evil')
      ).rejects.toThrow(MemorySecurityError);

      await fs.promises.rm(outsideDir, { recursive: true, force: true });
    });
  });

  describe('create operation', () => {
    it('creates a new file in root /memories', async () => {
      const res = await engine.create('/memories/notes.md', '# My Notes\nHello world');
      expect(res).toContain('Successfully created file');

      const content = await engine.view('/memories/notes.md');
      expect(content).toBe('# My Notes\nHello world');
    });

    it('recursively creates intermediate directories when creating a nested file', async () => {
      const res = await engine.create(
        '/memories/projects/asmo/architecture.txt',
        'Architecture specification'
      );
      expect(res).toContain('Successfully created file');

      const content = await engine.view('/memories/projects/asmo/architecture.txt');
      expect(content).toBe('Architecture specification');
    });

    it('creates a directory when content is undefined', async () => {
      const res = await engine.create('/memories/docs/subfolder');
      expect(res).toContain('Successfully created directory');

      const viewRes = await engine.view('/memories/docs/subfolder');
      expect(viewRes).toBe('(empty directory)');
    });

    it('throws MemoryConflictError if file already exists and overwrite is false', async () => {
      await engine.create('/memories/exist.txt', 'Initial content');
      await expect(
        engine.create('/memories/exist.txt', 'New content')
      ).rejects.toThrow(MemoryConflictError);
    });

    it('allows overwriting an existing file when options.overwrite is true', async () => {
      await engine.create('/memories/exist.txt', 'Initial content');
      await engine.create('/memories/exist.txt', 'Updated content', { overwrite: true });

      const content = await engine.view('/memories/exist.txt');
      expect(content).toBe('Updated content');
    });

    it('enforces maxFileSize restriction', async () => {
      const smallEngine = new FileMemoryEngine({ rootDir: tempDir, maxFileSize: 10 });
      await expect(
        smallEngine.create('/memories/large.txt', 'This string is longer than 10 bytes')
      ).rejects.toThrow(MemoryValidationError);
    });
  });

  describe('view operation', () => {
    it('views file content', async () => {
      await engine.create('/memories/hello.txt', 'Hello, Asmo!');
      const content = await engine.view('/memories/hello.txt');
      expect(content).toBe('Hello, Asmo!');
    });

    it('views directory entries with trailing slash for directories, sorted alphabetically', async () => {
      await engine.create('/memories/beta.txt', 'beta');
      await engine.create('/memories/alpha.txt', 'alpha');
      await engine.create('/memories/subfolder');
      await engine.create('/memories/subfolder/child.txt', 'child');

      const listing = await engine.view('/memories');
      expect(listing).toBe('alpha.txt\nbeta.txt\nsubfolder/');
    });

    it('returns (empty directory) for an empty directory', async () => {
      await engine.create('/memories/empty_dir');
      const listing = await engine.view('/memories/empty_dir');
      expect(listing).toBe('(empty directory)');
    });

    it('supports 1-indexed viewRange', async () => {
      const fileContent = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5';
      await engine.create('/memories/multiline.txt', fileContent);

      const slice = await engine.view('/memories/multiline.txt', { viewRange: [2, 4] });
      expect(slice).toBe('Line 2\nLine 3\nLine 4');
    });

    it('throws MemoryValidationError for invalid viewRange', async () => {
      await engine.create('/memories/multiline.txt', 'Line 1\nLine 2');
      await expect(
        engine.view('/memories/multiline.txt', { viewRange: [0, 2] })
      ).rejects.toThrow(MemoryValidationError);
      await expect(
        engine.view('/memories/multiline.txt', { viewRange: [4, 2] })
      ).rejects.toThrow(MemoryValidationError);
    });

    it('throws MemoryNotFoundError for non-existent file or directory', async () => {
      await expect(engine.view('/memories/missing.txt')).rejects.toThrow(
        MemoryNotFoundError
      );
    });
  });

  describe('str_replace operation', () => {
    it('atomically replaces a unique string in a file', async () => {
      await engine.create(
        '/memories/config.json',
        JSON.stringify({ name: 'Asmo', env: 'development' }, null, 2)
      );

      const res = await engine.str_replace(
        '/memories/config.json',
        '"env": "development"',
        '"env": "production"'
      );
      expect(res).toContain('Successfully replaced string');

      const content = await engine.view('/memories/config.json');
      expect(content).toContain('"env": "production"');
      expect(content).not.toContain('"env": "development"');
    });

    it('throws MemoryNotFoundError if oldStr is not found', async () => {
      await engine.create('/memories/sample.txt', 'The quick brown fox');
      await expect(
        engine.str_replace('/memories/sample.txt', 'lazy dog', 'sleepy cat')
      ).rejects.toThrow(MemoryNotFoundError);
    });

    it('throws MemoryConflictError if oldStr occurs multiple times without specifying index', async () => {
      await engine.create('/memories/repeat.txt', 'apple banana apple cherry apple');
      await expect(
        engine.str_replace('/memories/repeat.txt', 'apple', 'orange')
      ).rejects.toThrow(MemoryConflictError);
    });

    it('replaces specific occurrence when index is specified', async () => {
      await engine.create('/memories/repeat.txt', 'apple banana apple cherry apple');

      // Replace second occurrence (index 1 in 0-indexed)
      await engine.str_replace('/memories/repeat.txt', 'apple', 'ORANGE', { index: 1 });
      const content = await engine.view('/memories/repeat.txt');
      expect(content).toBe('apple banana ORANGE cherry apple');
    });

    it('throws MemoryValidationError for out-of-bounds occurrence index', async () => {
      await engine.create('/memories/repeat.txt', 'apple banana apple');
      await expect(
        engine.str_replace('/memories/repeat.txt', 'apple', 'orange', { index: 5 })
      ).rejects.toThrow(MemoryValidationError);
    });

    it('throws MemoryValidationError if oldStr is empty', async () => {
      await engine.create('/memories/sample.txt', 'some content');
      await expect(
        engine.str_replace('/memories/sample.txt', '', 'replacement')
      ).rejects.toThrow(MemoryValidationError);
    });

    it('throws MemoryValidationError when attempted on a directory', async () => {
      await engine.create('/memories/a_directory');
      await expect(
        engine.str_replace('/memories/a_directory', 'a', 'b')
      ).rejects.toThrow(MemoryValidationError);
    });
  });

  describe('insert operation', () => {
    it('inserts text at line 1 (top of file)', async () => {
      await engine.create('/memories/doc.txt', 'First line\nSecond line\n');
      await engine.insert('/memories/doc.txt', 1, 'Header line');

      const content = await engine.view('/memories/doc.txt');
      expect(content).toBe('Header line\nFirst line\nSecond line\n');
    });

    it('inserts text in the middle of a file (1-indexed)', async () => {
      await engine.create('/memories/doc.txt', 'Line 1\nLine 2\nLine 3');
      await engine.insert('/memories/doc.txt', 2, 'Inserted between 1 and 2');

      const content = await engine.view('/memories/doc.txt');
      expect(content).toBe('Line 1\nInserted between 1 and 2\nLine 2\nLine 3');
    });

    it('inserts text at the end of a file (line = lineCount + 1)', async () => {
      await engine.create('/memories/doc.txt', 'Line 1\nLine 2');
      await engine.insert('/memories/doc.txt', 3, 'Line 3');

      const content = await engine.view('/memories/doc.txt');
      expect(content).toBe('Line 1\nLine 2\nLine 3');
    });

    it('inserts into an empty file', async () => {
      await engine.create('/memories/empty.txt', '');
      await engine.insert('/memories/empty.txt', 1, 'First line ever');

      const content = await engine.view('/memories/empty.txt');
      expect(content).toBe('First line ever');
    });

    it('inserts multi-line text cleanly', async () => {
      await engine.create('/memories/doc.txt', 'Start\nEnd');
      await engine.insert('/memories/doc.txt', 2, 'Middle A\nMiddle B');

      const content = await engine.view('/memories/doc.txt');
      expect(content).toBe('Start\nMiddle A\nMiddle B\nEnd');
    });

    it('throws MemoryValidationError when line number is out of bounds', async () => {
      await engine.create('/memories/doc.txt', 'Single line');
      await expect(engine.insert('/memories/doc.txt', 0, 'Zero line')).rejects.toThrow(
        MemoryValidationError
      );
      await expect(engine.insert('/memories/doc.txt', 3, 'Too far')).rejects.toThrow(
        MemoryValidationError
      );
    });

    it('throws MemoryValidationError when attempted on a directory', async () => {
      await engine.create('/memories/test_dir');
      await expect(engine.insert('/memories/test_dir', 1, 'text')).rejects.toThrow(
        MemoryValidationError
      );
    });
  });

  describe('delete operation', () => {
    it('deletes a file', async () => {
      await engine.create('/memories/to_delete.txt', 'bye');
      expect(await engine.exists('/memories/to_delete.txt')).toBe(true);

      const res = await engine.delete('/memories/to_delete.txt');
      expect(res).toContain('Successfully deleted file');
      expect(await engine.exists('/memories/to_delete.txt')).toBe(false);
    });

    it('deletes a directory and its contents recursively', async () => {
      await engine.create('/memories/project/notes.txt', 'nested file');
      await engine.create('/memories/project/sub/more.txt', 'more');

      const res = await engine.delete('/memories/project');
      expect(res).toContain('Successfully deleted directory');
      expect(await engine.exists('/memories/project')).toBe(false);
    });

    it('throws MemoryNotFoundError if target does not exist', async () => {
      await expect(engine.delete('/memories/nonexistent.txt')).rejects.toThrow(
        MemoryNotFoundError
      );
    });
  });

  describe('rename operation', () => {
    it('renames a file in the same directory', async () => {
      await engine.create('/memories/original.txt', 'content');
      const res = await engine.rename('/memories/original.txt', '/memories/renamed.txt');
      expect(res).toContain('Successfully renamed');

      expect(await engine.exists('/memories/original.txt')).toBe(false);
      expect(await engine.view('/memories/renamed.txt')).toBe('content');
    });

    it('moves a file to a new nested subfolder (creating parent directories automatically)', async () => {
      await engine.create('/memories/item.txt', 'item data');
      await engine.rename('/memories/item.txt', '/memories/archive/2026/item.txt');

      expect(await engine.exists('/memories/item.txt')).toBe(false);
      expect(await engine.view('/memories/archive/2026/item.txt')).toBe('item data');
    });

    it('moves/renames a directory', async () => {
      await engine.create('/memories/v1/spec.txt', 'v1 spec');
      await engine.rename('/memories/v1', '/memories/v2');

      expect(await engine.exists('/memories/v1')).toBe(false);
      expect(await engine.view('/memories/v2/spec.txt')).toBe('v1 spec');
    });

    it('throws MemoryNotFoundError if source does not exist', async () => {
      await expect(
        engine.rename('/memories/no_source.txt', '/memories/dest.txt')
      ).rejects.toThrow(MemoryNotFoundError);
    });

    it('throws MemoryConflictError if destination exists and overwrite is false', async () => {
      await engine.create('/memories/source.txt', 'src');
      await engine.create('/memories/dest.txt', 'dst');

      await expect(
        engine.rename('/memories/source.txt', '/memories/dest.txt')
      ).rejects.toThrow(MemoryConflictError);
    });

    it('overwrites destination if overwrite is true', async () => {
      await engine.create('/memories/source.txt', 'new data');
      await engine.create('/memories/dest.txt', 'old data');

      await engine.rename('/memories/source.txt', '/memories/dest.txt', { overwrite: true });
      expect(await engine.view('/memories/dest.txt')).toBe('new data');
    });
  });

  describe('Tool Definition and Executor (Anthropic memory_20250818 inspired)', () => {
    it('has standard tool definition schema', () => {
      expect(memoryToolDefinition.name).toBe('memory');
      expect(memoryToolDefinition.type).toBe('memory_20250818');
      expect(memoryToolDefinition.input_schema.properties.command.enum).toEqual([
        'view',
        'create',
        'str_replace',
        'insert',
        'delete',
        'rename',
      ]);
    });

    it('executes create command via executeMemoryTool', async () => {
      const result = await executeMemoryTool(engine, {
        command: 'create',
        path: '/memories/tool_created.txt',
        file_text: 'Created by tool executor',
      });

      expect(result.success).toBe(true);
      expect(result.is_error).toBe(false);
      expect(result.content).toContain('Successfully created file');

      const viewRes = await executeMemoryTool(engine, {
        command: 'view',
        path: '/memories/tool_created.txt',
      });
      expect(viewRes.success).toBe(true);
      expect(viewRes.content).toBe('Created by tool executor');
    });

    it('executes str_replace with camelCase and snake_case aliases', async () => {
      await engine.create('/memories/replace_test.txt', 'Hello world foo');

      const executor = createMemoryToolExecutor(engine);
      const res = await executor({
        command: 'str_replace',
        path: '/memories/replace_test.txt',
        old_str: 'foo',
        new_str: 'bar',
      });

      expect(res.success).toBe(true);
      expect(await engine.view('/memories/replace_test.txt')).toBe('Hello world bar');
    });

    it('executes insert with insert_line (0-indexed converted to 1-indexed)', async () => {
      await engine.create('/memories/insert_test.txt', 'Line 1\nLine 2');

      const executor = createMemoryToolExecutor(engine);
      const res = await executor({
        command: 'insert',
        path: '/memories/insert_test.txt',
        insert_line: 0, // Anthropic 0-indexed top of file
        insert_text: 'Line 0',
      });

      expect(res.success).toBe(true);
      expect(await engine.view('/memories/insert_test.txt')).toBe('Line 0\nLine 1\nLine 2');
    });

    it('executes rename with old_path and new_path', async () => {
      await engine.create('/memories/pre_rename.txt', 'data');

      const executor = createMemoryToolExecutor(engine);
      const res = await executor({
        command: 'rename',
        old_path: '/memories/pre_rename.txt',
        new_path: '/memories/post_rename.txt',
      });

      expect(res.success).toBe(true);
      expect(await engine.exists('/memories/pre_rename.txt')).toBe(false);
      expect(await engine.view('/memories/post_rename.txt')).toBe('data');
    });

    it('executes delete command', async () => {
      await engine.create('/memories/remove_me.txt', 'data');

      const executor = createMemoryToolExecutor(engine);
      const res = await executor({
        command: 'delete',
        path: '/memories/remove_me.txt',
      });

      expect(res.success).toBe(true);
      expect(await engine.exists('/memories/remove_me.txt')).toBe(false);
    });

    it('returns structured error with success: false and is_error: true on failure', async () => {
      const executor = createMemoryToolExecutor(engine);
      const res = await executor({
        command: 'view',
        path: '/memories/nonexistent_file.txt',
      });

      expect(res.success).toBe(false);
      expect(res.is_error).toBe(true);
      expect(res.error).toContain('File or directory not found');
      expect(res.toString()).toContain('File or directory not found');
    });

    it('returns structured error on security attack through executor', async () => {
      const executor = createMemoryToolExecutor(engine);
      const res = await executor({
        command: 'view',
        path: '/etc/passwd',
      });

      expect(res.success).toBe(false);
      expect(res.is_error).toBe(true);
      expect(res.error).toContain("Path must start with '/memories'");
    });
  });
});
