import { ghosttyWasmUrl, ghosttyWritePtyWasmUrl } from "./assets.ts";

type WasmFunction = (...args: Array<number | bigint>) => number;

interface TypeField {
  readonly offset: number;
  readonly size: number;
  readonly type: string;
}

interface TypeLayout {
  readonly size: number;
  readonly align: number;
  readonly fields: Readonly<Record<string, TypeField>>;
}

type TypeLayouts = Readonly<Record<string, TypeLayout>>;

const textDecoder = new TextDecoder();

/**
 * The loaded libghostty-vt WebAssembly module, and the marshalling the rest of
 * the terminal uses to reach it: allocation, struct field access against the
 * layouts the module publishes, and the callback table that lets terminal
 * output reach a JavaScript pty writer.
 */
export class GhosttyRuntime {
  /** The module's linear memory, which every pointer here indexes. */
  readonly memory: WebAssembly.Memory;
  /** Struct layouts the module publishes, keyed by type name. */
  readonly layouts: TypeLayouts;
  private readonly exports: WebAssembly.Exports;
  private readonly ptyWriters = new Map<number, (data: string) => void>();
  private nextPtyWriterId = 1;
  private writePtyFunctionIndex = 0;

  private constructor(instance: WebAssembly.Instance) {
    this.exports = instance.exports;
    const memory = instance.exports.memory;
    if (!(memory instanceof WebAssembly.Memory)) {
      throw new Error("libghostty-vt did not export WebAssembly memory");
    }
    this.memory = memory;
    const jsonPointer = this.call("ghostty_type_json");
    const bytes = new Uint8Array(memory.buffer);
    let end = jsonPointer;
    while (end < bytes.length && bytes[end] !== 0) end += 1;
    this.layouts = JSON.parse(textDecoder.decode(bytes.subarray(jsonPointer, end))) as TypeLayouts;
  }

  /**
   * Fetch and instantiate the module, then install the pty callback
   * trampoline so the runtime is usable the moment it resolves.
   * @returns the loaded runtime.
   * @throws when either WebAssembly asset cannot be fetched or instantiated.
   */
  static async load(): Promise<GhosttyRuntime> {
    const response = await fetch(ghosttyWasmUrl);
    if (!response.ok) {
      throw new Error(`Unable to load libghostty-vt (${response.status})`);
    }
    let instance: WebAssembly.Instance | undefined;
    const imports = {
      env: {
        log: (pointer: number, length: number) => {
          if (!instance) return;
          const memory = instance.exports.memory;
          if (!(memory instanceof WebAssembly.Memory)) return;
          const message = textDecoder.decode(new Uint8Array(memory.buffer, pointer, length));
          console.debug("[libghostty-vt]", message);
        },
      },
    };
    const result = await WebAssembly.instantiate(await response.arrayBuffer(), imports);
    instance = result.instance;
    const runtime = new GhosttyRuntime(result.instance);
    await runtime.installWritePtyTrampoline();
    return runtime;
  }

  /**
   * Call one module export.
   * @param name - the export's name.
   * @param args - the call's arguments.
   * @returns whatever the export returned.
   * @throws when the module exports no such function.
   */
  call(name: string, ...args: Array<number | bigint>): number {
    const fn = this.exports[name];
    if (typeof fn !== "function") {
      throw new Error(`libghostty-vt export is unavailable: ${name}`);
    }
    return (fn as WasmFunction)(...args);
  }

  /**
   * The published layout of one struct type.
   * @param name - the type's name.
   * @returns its size, alignment, and fields.
   * @throws when the module publishes no such type.
   */
  layout(name: string): TypeLayout {
    const layout = this.layouts[name];
    if (!layout) throw new Error(`libghostty-vt type layout is unavailable: ${name}`);
    return layout;
  }

  /**
   * Allocate zeroed bytes in the module's memory.
   * @param size - how many bytes.
   * @returns a pointer the caller must pass to `free`.
   * @throws when the allocation fails.
   */
  alloc(size: number): number {
    const pointer = this.call("ghostty_wasm_alloc_u8_array", size);
    if (pointer === 0) throw new Error(`libghostty-vt failed to allocate ${size} bytes`);
    new Uint8Array(this.memory.buffer, pointer, size).fill(0);
    return pointer;
  }

  /**
   * Release an allocation. A null pointer is ignored, so cleanup paths need no
   * guard of their own.
   * @param pointer - the allocation, or 0.
   * @param size - the size it was allocated with.
   */
  free(pointer: number, size: number): void {
    if (pointer !== 0) this.call("ghostty_wasm_free_u8_array", pointer, size);
  }

  /**
   * Allocate a slot to receive an opaque handle from a `*_new` call.
   * @returns a pointer the caller must pass to `freeOpaque`.
   * @throws when the allocation fails.
   */
  allocOpaque(): number {
    const pointer = this.call("ghostty_wasm_alloc_opaque");
    if (pointer === 0) throw new Error("libghostty-vt failed to allocate an opaque pointer");
    // The slot is uninitialized until a *_new call writes it; zero it so dispose
    // paths that run after a partial initialization never free a garbage pointer.
    new DataView(this.memory.buffer).setUint32(pointer, 0, true);
    return pointer;
  }

  /**
   * Release an opaque-handle slot. A null pointer is ignored.
   * @param pointer - the slot, or 0.
   */
  freeOpaque(pointer: number): void {
    if (pointer !== 0) this.call("ghostty_wasm_free_opaque", pointer);
  }

  /**
   * Read the handle a `*_new` call wrote into a slot.
   * @param slot - a slot from `allocOpaque`.
   * @returns the handle, or 0 when nothing was written.
   */
  readPointer(slot: number): number {
    return new DataView(this.memory.buffer).getUint32(slot, true);
  }

  /**
   * Route one terminal's replies — cursor reports, mode queries — to a
   * JavaScript writer, through the module's indirect callback table.
   * @param terminal - the terminal handle.
   * @param writer - receives the bytes the terminal wants written to the pty.
   * @param writer.data - the reply text.
   * @returns a registration id to pass to `detachPtyWriter`.
   * @throws when the trampoline was never installed.
   */
  attachPtyWriter(terminal: number, writer: (data: string) => void): number {
    if (this.writePtyFunctionIndex === 0) {
      throw new Error("libghostty-vt PTY callback trampoline is unavailable");
    }
    const id = this.nextPtyWriterId++;
    this.ptyWriters.set(id, writer);
    this.call("ghostty_terminal_set", terminal, 0, id);
    this.call("ghostty_terminal_set", terminal, 1, this.writePtyFunctionIndex);
    return id;
  }

  /**
   * Stop routing a terminal's replies and drop the writer.
   * @param terminal - the terminal handle.
   * @param id - the id `attachPtyWriter` returned.
   */
  detachPtyWriter(terminal: number, id: number): void {
    this.call("ghostty_terminal_set", terminal, 1, 0);
    this.call("ghostty_terminal_set", terminal, 0, 0);
    this.ptyWriters.delete(id);
  }

  /**
   * A `DataView` over module memory. Views are invalidated by any allocation
   * that grows memory, so take one per use rather than caching it.
   * @param pointer - where the view starts.
   * @param size - how many bytes it covers; to the end of memory when omitted.
   * @returns the view.
   */
  view(pointer: number, size?: number): DataView {
    return new DataView(this.memory.buffer, pointer, size);
  }

  /**
   * A byte view over module memory, with the same lifetime caveat as `view`.
   * @param pointer - where the view starts.
   * @param size - how many bytes it covers.
   * @returns the view.
   */
  bytes(pointer: number, size: number): Uint8Array {
    return new Uint8Array(this.memory.buffer, pointer, size);
  }

  /**
   * Write one struct field, using the width and offset the module published
   * rather than an offset hard-coded on this side.
   * @param pointer - the struct's address.
   * @param structName - the struct's type name.
   * @param fieldName - the field to write.
   * @param value - the value, narrowed to the field's width.
   * @throws when the field is unknown or has a type this cannot write.
   */
  setField(pointer: number, structName: string, fieldName: string, value: number): void {
    const field = this.layout(structName).fields[fieldName];
    if (!field) throw new Error(`libghostty-vt field is unavailable: ${structName}.${fieldName}`);
    const view = this.view(pointer + field.offset, field.size);
    switch (field.type) {
      case "bool":
      case "u8":
        view.setUint8(0, value);
        return;
      case "u16":
        view.setUint16(0, value, true);
        return;
      case "i32":
        view.setInt32(0, value, true);
        return;
      case "u32":
      case "enum":
        view.setUint32(0, value, true);
        return;
      case "u64":
        view.setBigUint64(0, BigInt(value), true);
        return;
      default:
        throw new Error(`Unsupported libghostty-vt field type: ${field.type}`);
    }
  }

  /**
   * Read one struct field, using the published layout.
   * @param pointer - the struct's address.
   * @param structName - the struct's type name.
   * @param fieldName - the field to read.
   * @returns the field's value as a number.
   * @throws when the field is unknown or has a type this cannot read.
   */
  readField(pointer: number, structName: string, fieldName: string): number {
    const field = this.layout(structName).fields[fieldName];
    if (!field) throw new Error(`libghostty-vt field is unavailable: ${structName}.${fieldName}`);
    const view = this.view(pointer + field.offset, field.size);
    switch (field.type) {
      case "bool":
      case "u8":
        return view.getUint8(0);
      case "u16":
        return view.getUint16(0, true);
      case "i32":
        return view.getInt32(0, true);
      case "u32":
      case "enum":
        return view.getUint32(0, true);
      case "u64":
        return Number(view.getBigUint64(0, true));
      default:
        throw new Error(`Unsupported libghostty-vt field type: ${field.type}`);
    }
  }

  private async installWritePtyTrampoline(): Promise<void> {
    const response = await fetch(ghosttyWritePtyWasmUrl);
    if (!response.ok) {
      throw new Error(`Unable to load the libghostty-vt PTY trampoline (${response.status})`);
    }
    const result = await WebAssembly.instantiate(await response.arrayBuffer(), {
      env: {
        t3_write_pty: (_terminal: number, userdata: number, pointer: number, length: number) => {
          const writer = this.ptyWriters.get(userdata);
          if (!writer || length === 0) return;
          writer(textDecoder.decode(new Uint8Array(this.memory.buffer, pointer, length)));
        },
      },
    });
    const trampoline = result.instance.exports.ghostty_write_pty;
    const table = this.exports.__indirect_function_table;
    if (typeof trampoline !== "function" || !(table instanceof WebAssembly.Table)) {
      throw new Error("libghostty-vt did not expose its callback table");
    }
    const index = table.length;
    // grow-then-set instead of grow(1, fn): WebKit stores a grow init value
    // with broken type information and every later call_indirect through the
    // entry traps with a signature mismatch. table.set canonicalizes correctly.
    table.grow(1);
    table.set(index, trampoline);
    this.writePtyFunctionIndex = index;
  }
}

let runtimePromise: Promise<GhosttyRuntime> | null = null;

/**
 * The shared runtime, loaded once for the page. A failed load is not cached,
 * so a terminal opened after a transient fetch failure retries.
 * @returns the runtime, once it is ready.
 */
export function loadGhosttyRuntime(): Promise<GhosttyRuntime> {
  runtimePromise ??= GhosttyRuntime.load().catch((error) => {
    runtimePromise = null;
    throw error;
  });
  return runtimePromise;
}
