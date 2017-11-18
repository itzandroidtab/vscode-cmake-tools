import * as path from 'path';
import * as child_process from 'child_process';

import * as vscode from 'vscode';

import config from './config';
import {execute} from './proc';

/**
 * Escape a string so it can be used as a regular expression
 */
export function escapeStringForRegex(str: string): string {
  return str.replace(/([.*+?^=!:${}()|\[\]\/\\])/g, '\\$1');
}

/**
 * Replace all occurrences of `needle` in `str` with `what`
 * @param str The input string
 * @param needle The search string
 * @param what The value to insert in place of `needle`
 * @returns The modified string
 */
export function replaceAll(str: string, needle: string, what: string) {
  const pattern = escapeStringForRegex(needle);
  const re = new RegExp(pattern, 'g');
  return str.replace(re, what);
}

/**
 * Remove all occurrences of a list of strings from a string.
 * @param str The input string
 * @param patterns Strings to remove from `str`
 * @returns The modified string
 */
export function removeAllPatterns(str: string, patterns: string[]): string {
  return patterns.reduce((acc, needle) => { return replaceAll(acc, needle, ''); }, str);
}

/**
 * Completely normalize/canonicalize a path.
 * Using `path.normalize` isn't sufficient. We want convert all paths to use
 * POSIX separators, remove redundant separators, and sometimes normalize the
 * case of the path.
 *
 * @param p The input path
 * @param normalize_case Whether we should normalize the case of the path
 * @returns The normalized path
 */
export function normalizePath(p: string, normalize_case = true): string {
  let norm = path.normalize(p);
  while (path.sep !== path.posix.sep && norm.includes(path.sep)) {
    norm = norm.replace(path.sep, path.posix.sep);
  }
  if (normalize_case && process.platform === 'win32') {
    norm = norm.toLocaleLowerCase().normalize();
  }
  norm = norm.replace(/\/$/, '');
  while (norm.includes('//')) {
    norm = replaceAll(norm, '//', '/');
  }
  return norm;
}

/**
 * Replace variable references with the corresponding variables
 * @param str The input string
 */
export function replaceVars(str: string): string {
  const replacements: {[key: string] : string} = {
    ['${workspaceRoot}'] : vscode.workspace.rootPath || '.',
    ['${workspaceRootFolderName}'] : path.basename(vscode.workspace.rootPath || '.'),
    ['${toolset}'] : config.toolset || 'unknown',
  };
  return Object.keys(replacements)
      .reduce((acc, key) => replaceAll(acc, key, replacements[key]), str);
}

/**
 * Check if a value is "truthy" according to CMake's own language rules
 * @param value The value to check
 */
export function isTruthy(value: (boolean | string | null | undefined | number)) {
  if (typeof value === 'string') {
    return !([ '', 'FALSE', 'OFF', '0', 'NOTFOUND', 'NO', 'N', 'IGNORE' ].indexOf(value) >= 0
             || value.endsWith('-NOTFOUND'));
  }
  // Numbers/bools/etc. follow common C-style truthiness
  return !!value;
}

/**
 * Generate an array of key-value pairs from an object using
 * `getOwnPropertyNames`
 * @param obj The object to iterate
 */
export function objectPairs<V>(obj: {[key: string] : V}): [ string, V ][] {
  return Object.getOwnPropertyNames(obj).map(key => ([ key, obj[key] ] as[string, V]));
}

/**
 * Map an iterable by some projection function
 * @param iter An iterable to map
 * @param proj The projection function
 */
export function * map<In, Out>(iter: Iterable<In>, proj: (arg: In) => Out): Iterator<Out> {
  for (const item of iter) {
    yield proj(item);
  }
}

export function reduce<In, Out>(iter: Iterable<In>, init: Out, mapper: (acc: Out, el: In) => Out):
    Out {
  for (const item of iter) {
    init = mapper(init, item);
  }
  return init;
}

/**
 * Generate a random integral value.
 * @param min Minimum value
 * @param max Maximum value
 */
export function randint(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min) + min);
}


export function product<T>(arrays: T[][]): T[][] {
  // clang-format off
  return arrays.reduce((acc, curr) =>
    acc
      // Append each element of the current array to each list already accumulated
      .map(
        prev => curr.map(
          item => prev.concat(item)
        )
      )
      .reduce(
        // Join all the lists
        (a, b) => a.concat(b),
        []
      ),
      [[]] as T[][]
    );
  // clang-format on
}

export interface CMakeValue {
  type: ('UNKNOWN' | 'BOOL' | 'STRING'); // There are more types, but we don't care ATM
  value: string;
}

export function cmakeify(value: (string | boolean | number | string[])): CMakeValue {
  const ret: CMakeValue = {
    type: 'UNKNOWN',
    value: '',
  };
  if (value === true || value === false) {
    ret.type = 'BOOL';
    ret.value = value ? 'TRUE' : 'FALSE';
  } else if (typeof(value) === 'string') {
    ret.type = 'STRING';
    ret.value = replaceAll(value, ';', '\\;');
  } else if (value instanceof Number || typeof value === 'number') {
    ret.type = 'STRING';
    ret.value = value.toString();
  } else if (value instanceof Array) {
    ret.type = 'STRING';
    ret.value = value.join(';');
  } else {
    throw new Error(`Invalid value to convert to cmake value: ${value}`)
  }
  return ret;
}


export async function termProc(child: child_process.ChildProcess) {
  // Stopping the process isn't as easy as it may seem. cmake --build will
  // spawn child processes, and CMake won't forward signals to its
  // children. As a workaround, we list the children of the cmake process
  // and also send signals to them.
  await _killTree(child.pid); return true;
}

async function _killTree(pid: number) {
  if (process.platform !== 'win32') {
    let children: number[] = [];
    const stdout = (await execute('pgrep', [ '-P', pid.toString() ], null, {silent : true}).result)
                       .stdout.trim();
    if (!!stdout.length) {
      children = stdout.split('\n').map(line => Number.parseInt(line));
    }
    for (const other of children) {
      if (other)
        await _killTree(other);
    }
    try {
      process.kill(pid, 'SIGINT');
    } catch (e) {
      if (e.code === 'ESRCH') {
        // Do nothing. We're okay.
      } else {
        throw e;
      }
    }
  } else {// Because reasons, Node's proc.kill doesn't work on killing child
          // processes transitively. We have to do a sad and manually kill the
          // task using taskkill.
          child_process.exec('taskkill /pid ' + pid.toString() + ' /T /F');}
}

export function splitCommandLine(cmd: string): string[] {
  const cmd_re = /('(\\'|[^'])*'|"(\\"|[^"])*"|(\\ |[^ ])+|[\w-]+)/g;
  const quoted_args = cmd.match(cmd_re);
  console.assert(quoted_args);
  // Our regex will parse escaped quotes, but they remain. We must
  // remove them ourselves
  return quoted_args !.map(arg => arg.replace(/\\(")/g, '$1').replace(/^"(.*)"$/g, '$1'));

}