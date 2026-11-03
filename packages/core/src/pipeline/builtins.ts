import type { ResolverFamily } from "../discovery/language.js";

const JS_CONSTRUCTORS = [
  "Array", "ArrayBuffer", "BigInt", "BigInt64Array", "BigUint64Array", "Boolean", "DataView", "Date", "Error",
  "AggregateError", "EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError", "URIError",
  "Float32Array", "Float64Array", "Function", "Int8Array", "Int16Array", "Int32Array", "Map", "Number", "Object",
  "Promise", "Proxy", "RegExp", "Set", "SharedArrayBuffer", "String", "Symbol", "Uint8Array", "Uint8ClampedArray",
  "Uint16Array", "Uint32Array", "WeakMap", "WeakSet", "WeakRef", "FinalizationRegistry",
  "URL", "URLSearchParams", "TextEncoder", "TextDecoder", "AbortController", "Blob", "File", "FileReader", "FormData",
  "Headers", "Request", "Response", "Event", "CustomEvent", "EventTarget", "MessageChannel", "BroadcastChannel",
  "Worker", "WebSocket", "XMLHttpRequest", "Image", "Audio", "ResizeObserver", "MutationObserver",
  "IntersectionObserver", "PerformanceObserver", "DOMParser", "XMLSerializer", "ReadableStream", "WritableStream",
  "TransformStream", "DOMException",
];

/** Built-ins in the language do not need to be imported for direct calls. Locally defined functions and import bindings take precedence over them, so user-defined functions with the same name will not be overridden. */
const BUILTIN_FUNCTIONS: Record<ResolverFamily, ReadonlySet<string>> = {
  ts: new Set([
    ...JS_CONSTRUCTORS,
    "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURI", "encodeURIComponent", "decodeURI",
    "decodeURIComponent", "escape", "unescape", "eval", "setTimeout", "setInterval", "clearTimeout", "clearInterval",
    "setImmediate", "clearImmediate", "queueMicrotask", "structuredClone", "requestAnimationFrame",
    "cancelAnimationFrame", "requestIdleCallback", "cancelIdleCallback", "atob", "btoa", "fetch", "alert", "confirm",
    "prompt", "getComputedStyle", "matchMedia", "require",
  ]),
  python: new Set([
    "abs", "aiter", "all", "anext", "any", "ascii", "bin", "bool", "breakpoint", "bytearray", "bytes", "callable",
    "chr", "classmethod", "compile", "complex", "delattr", "dict", "dir", "divmod", "enumerate", "eval", "exec",
    "filter", "float", "format", "frozenset", "getattr", "globals", "hasattr", "hash", "help", "hex", "id", "input",
    "int", "isinstance", "issubclass", "iter", "len", "list", "locals", "map", "max", "memoryview", "min", "next",
    "object", "oct", "open", "ord", "pow", "print", "property", "range", "repr", "reversed", "round", "set",
    "setattr", "slice", "sorted", "staticmethod", "str", "sum", "super", "tuple", "type", "vars", "zip", "__import__",
    "BaseException", "Exception", "ArithmeticError", "AssertionError", "AttributeError", "EOFError",
    "FileExistsError", "FileNotFoundError", "ImportError", "IndexError", "KeyError", "KeyboardInterrupt",
    "LookupError", "MemoryError", "ModuleNotFoundError", "NameError", "NotImplementedError", "OSError", "IOError",
    "OverflowError", "PermissionError", "RecursionError", "RuntimeError", "StopIteration", "StopAsyncIteration",
    "TimeoutError", "TypeError", "UnicodeDecodeError", "UnicodeEncodeError", "ValueError", "ZeroDivisionError",
    "ConnectionError", "Warning", "DeprecationWarning", "UserWarning",
  ]),
  go: new Set([
    "append", "cap", "clear", "close", "complex", "copy", "delete", "imag", "len", "make", "max", "min", "new",
    "panic", "print", "println", "real", "recover", "bool", "byte", "complex64", "complex128", "error", "float32",
    "float64", "int", "int8", "int16", "int32", "int64", "rune", "string", "uint", "uint8", "uint16", "uint32",
    "uint64", "uintptr", "any",
  ]),
  // Macros do not carry `!`; Some / Ok / Err are enum constructors in the prelude, and syntactically they are the same as function calls
  rust: new Set([
    "println", "print", "eprintln", "eprint", "format", "write", "writeln", "vec", "panic", "assert", "assert_eq",
    "assert_ne", "debug_assert", "debug_assert_eq", "debug_assert_ne", "unreachable", "unimplemented", "todo",
    "matches", "dbg", "format_args", "concat", "stringify", "include_str", "include_bytes", "include", "env",
    "option_env", "cfg", "line", "file", "column", "module_path", "compile_error", "thread_local", "Some", "Ok",
    "Err", "drop",
  ]),
};

const JS_RECEIVERS = new Set([
  ...JS_CONSTRUCTORS,
  "console", "Math", "JSON", "Reflect", "Intl", "Atomics", "WebAssembly", "globalThis", "process", "Buffer",
  "self", "window", "document", "navigator", "location", "history", "localStorage", "sessionStorage",
  "performance", "crypto", "customElements", "indexedDB", "caches", "module", "require", "import",
]);

/** Method calls starting with these names fall on the language built-ins; it does not count when the receiver is shadowed by an import binding. */
const BUILTIN_RECEIVERS: Record<ResolverFamily, ReadonlySet<string>> = {
  ts: JS_RECEIVERS,
  // In Python, self refers to the instance itself and cannot be used in the same way as window.self in JS.
  python: new Set(["str", "bytes", "dict", "list", "set", "frozenset", "tuple", "int", "float", "bool", "object", "type"]),
  go: new Set(),
  rust: new Set([
    "std", "core", "alloc", "String", "Vec", "Box", "Rc", "Arc", "Option", "Result", "Some", "str", "char", "bool",
    "i8", "i16", "i32", "i64", "i128", "isize", "u8", "u16", "u32", "u64", "u128", "usize", "f32", "f64",
  ]),
};

export function isBuiltinFunction(family: ResolverFamily | undefined, name: string): boolean {
  return family !== undefined && BUILTIN_FUNCTIONS[family].has(name);
}

/** Languages without a module resolver follow the JS approach: these names, in them as well, are not part of user code. */
export function isBuiltinReceiver(family: ResolverFamily | undefined, head: string): boolean {
  return (family === undefined ? JS_RECEIVERS : BUILTIN_RECEIVERS[family]).has(head);
}

/**
 * Built-in types in type annotations → external names. Method calls on these types are built into the language,
 * For example, `name.trim()` after `name: string`.
 */
const BUILTIN_TYPES: Record<ResolverFamily, Readonly<Record<string, string>>> = {
  ts: {
    string: "String", number: "Number", boolean: "Boolean", bigint: "BigInt", symbol: "Symbol",
    ...Object.fromEntries(JS_CONSTRUCTORS.map((name) => [name, name])),
    ReadonlyArray: "Array", ReadonlyMap: "Map", ReadonlySet: "Set", Record: "Object", Partial: "Object",
    Readonly: "Object", Required: "Object", Pick: "Object", Omit: "Object", PromiseLike: "Promise",
    Iterable: "Iterable", Iterator: "Iterator", AsyncIterable: "AsyncIterable", Generator: "Generator",
    AsyncGenerator: "AsyncGenerator", RegExpMatchArray: "Array",
  },
  python: Object.fromEntries(
    ["str", "bytes", "bytearray", "dict", "list", "set", "frozenset", "tuple", "int", "float", "bool", "complex"]
      .flatMap((name) => [[name, name], [name.charAt(0).toUpperCase() + name.slice(1), name]]),
  ),
  go: {},
  rust: Object.fromEntries(
    ["String", "Vec", "Option", "Result", "Box", "Rc", "Arc", "str", "char", "bool", "i8", "i16", "i32", "i64",
      "i128", "isize", "u8", "u16", "u32", "u64", "u128", "usize", "f32", "f64"].map((name) => [name, name]),
  ),
};

export function builtinType(family: ResolverFamily | undefined, name: string): string | null {
  if (family === undefined) return null;
  return BUILTIN_TYPES[family][name] ?? null;
}
