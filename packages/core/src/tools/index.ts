import type { Tool } from '../types.ts';
import { editFile, glob, listDir, readFile, writeFile } from './fs.ts';
import { todoWrite, webFetch } from './misc.ts';
import { bash, grep } from './shell.ts';

export { exec } from './shell.ts';
export { htmlToText } from './misc.ts';

export function builtinTools(): Tool[] {
  return [readFile, writeFile, editFile, listDir, glob, grep, bash, todoWrite, webFetch];
}
