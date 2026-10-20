import { z } from 'zod';

export class MemoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryError';
  }
}

export class MemorySecurityError extends MemoryError {
  constructor(message: string) {
    super(message);
    this.name = 'MemorySecurityError';
  }
}

export class MemoryNotFoundError extends MemoryError {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryNotFoundError';
  }
}

export class MemoryConflictError extends MemoryError {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryConflictError';
  }
}

export class MemoryValidationError extends MemoryError {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryValidationError';
  }
}

export interface FileMemoryConfig {
  /**
   * Root directory on local filesystem backing /memories.
   * Defaults to './work/memories'.
   */
  rootDir?: string;
  /**
   * Default file overwrite policy when creating files.
   * Defaults to false (prevent accidental overwrites).
   */
  defaultOverwrite?: boolean;
  /**
   * Maximum file size in bytes (e.g. 10MB).
   */
  maxFileSize?: number;
}

export type MemoryCommand =
  | 'view'
  | 'create'
  | 'str_replace'
  | 'insert'
  | 'delete'
  | 'rename';

export interface ViewOptions {
  /**
   * 1-indexed [startLine, endLine] range.
   */
  viewRange?: [number, number];
}

export interface CreateOptions {
  overwrite?: boolean;
}

export interface StrReplaceOptions {
  /**
   * 0-indexed or 1-indexed occurrence index if string occurs multiple times.
   */
  index?: number;
}

export interface RenameOptions {
  overwrite?: boolean;
}

export const memoryCommandSchema = z.enum([
  'view',
  'create',
  'str_replace',
  'insert',
  'delete',
  'rename',
]);

export const memoryToolInputSchema = z.object({
  command: memoryCommandSchema,
  path: z.string().optional(),
  // Content aliases
  content: z.string().optional(),
  file_text: z.string().optional(),
  // String replacement aliases
  oldStr: z.string().optional(),
  old_str: z.string().optional(),
  newStr: z.string().optional(),
  new_str: z.string().optional(),
  index: z.number().int().optional(),
  // Line insertion aliases
  line: z.number().int().optional(),
  insert_line: z.number().int().optional(),
  text: z.string().optional(),
  insert_text: z.string().optional(),
  // Rename aliases
  oldPath: z.string().optional(),
  old_path: z.string().optional(),
  newPath: z.string().optional(),
  new_path: z.string().optional(),
  // View range aliases
  viewRange: z.tuple([z.number().int().positive(), z.number().int().positive()]).optional(),
  view_range: z.tuple([z.number().int().positive(), z.number().int().positive()]).optional(),
});

export type MemoryToolInput = z.infer<typeof memoryToolInputSchema>;

export interface MemoryToolResult {
  success: boolean;
  content: string;
  is_error: boolean;
  error?: string;
  toString(): string;
}
