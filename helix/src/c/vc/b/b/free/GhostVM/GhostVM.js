'use strict';

// ── dep.jl + DirectoryManager ─────────────────────────────────────────────────
const _DEP_JL = process.env.HELIX_DEP  || 'F:/helix/.helix/dep.jl';
const _JULIA  = process.env.HELIX_JULIA || 'julia';
const { execFileSync } = require('child_process');

function _dep(key) {
    const v = execFileSync(_JULIA, [_DEP_JL, 'get', key], { encoding: 'utf8' }).trim();
    if (!v || v === 'not found') throw new Error(`[GhostVM] dep.jl missing: ${key}`);
    return v;
}
let _DM_PATH;
function _dmResolve(name) {
    if (!_DM_PATH) _DM_PATH = _dep('HELIX_DM');
    const raw = execFileSync(_JULIA, [_DM_PATH, 'grep', name], { encoding: 'utf8' }).trim();
    const lines = raw.split('\n').map(l => l.trim())
        .filter(l => l && !l.startsWith('[DM]') && !l.startsWith('grep '));
    const match = lines.find(l => l.split(/[\\/]/).pop() === name) || lines[0];
    if (!match) throw new Error(`[GhostVM] DM could not resolve: ${name}`);
    return match;
}

// ─────────────────────────────────────────────────────────────────────────────
//  GhostVM — Ghost ZWC stack machine interpreter
//  vc frame · b/b layer · free tier
//
//  Ghost ZWC Universal IR: 4 zero-width Unicode chars encode Klein-4 group nodes.
//  They are the 4 roots of z⁴=1 in F(z)=4z³/(z⁴−1) (OFI characteristic eq).
//
//  Alphabet:
//    U+200B  ZWSP  00  cc  → STACK  ops       (public)
//    U+200C  ZWNJ  01  cv  → ARITHMETIC       (signed-in)
//    U+200D  ZWJ   10  vc  → FLOW CONTROL     (suite+)
//    U+2060  WJ    11  vv  → HEAP / I/O       (vault)
//
//  Encoding is invisible in rendered text; programs embed ZWC IR inline.
// ─────────────────────────────────────────────────────────────────────────────

const ZWC = Object.freeze({
    S: '​',   // ZWSP  00  cO  stack
    N: '‌',   // ZWNJ  01  cI  arithmetic
    J: '‍',   // ZWJ   10  vO  flow
    I: '⁠',   // WJ    11  vI  heap/io
});

const { S, N, J, I } = ZWC;
// ── Encoding rules ────────────────────────────────────────────────────────────
// S = SEPARATOR ONLY. Never a digit, never an opcode content bit.
//     S terminates BOTH opcodes and numbers.
// {N, J, I} = content bits (opcode body + digits, base-3: N=0, J=1, I=2)
//
// Opcode format: [N|J|I]+ S   (one or more content bits, terminated by S)
// Number format: [N|I] [N|J|I]* S   (sign: N=pos, I=neg; digits base-3; terminated by S)
//
// This means S is ALWAYS an unambiguous boundary — no greedy-lookahead ambiguity.
//
// Opcode table:
//  Stack:   N,S=PUSH(n)  N,N,S=DUP  N,J,S=POP  N,I,S=SWAP  N,N,N,S=COPY(n)  N,N,J,S=SLIDE(n)
//  Arith:   J,N,S=ADD    J,J,S=SUB  J,I,S=MUL  J,N,N,S=DIV  J,N,J,S=MOD
//  Flow:    I,N,N,S=LABEL(n) I,N,J,S=CALL(n) I,N,I,S=JUMP(n)
//           I,J,N,S=JZ(n)   I,J,J,S=JN(n)   I,J,I,S=RET    I,I,S=END
//  Heap/IO: I,N,N,N,S=STORE  I,N,N,J,S=RETRIEVE
//           I,I,N,S=OUT_CHAR  I,I,J,S=OUT_NUM  I,I,I,S=IN_CHAR  I,I,N,N,S=IN_NUM
const _DIGITS = [N, J, I];    // base-3: N=0, J=1, I=2

// ── ZWC extraction ────────────────────────────────────────────────────────────
const _ZWC_SET = new Set(Object.values(ZWC));
function extractZWC(src) {
    return [...src].filter(c => _ZWC_SET.has(c)).join('');
}

// ── Number encoding ───────────────────────────────────────────────────────────
// Format: <sign> <base-4 digits> <S S terminator>
// sign: S=positive, I=negative
function encodeNumber(n) {
    // Sign: N=positive, I=negative. Digits: base-3 {N,J,I}. Terminator: single S.
    if (n === 0) return N + S;    // positive sign, no digits, terminator
    const sign = n >= 0 ? N : I;
    let abs = Math.abs(n);
    const digits = [];
    while (abs > 0) { digits.unshift(_DIGITS[abs % 3]); abs = Math.floor(abs / 3); }
    return sign + digits.join('') + S;
}

function decodeNumber(src, pos) {
    if (pos >= src.length) throw new Error(`[GhostVM] unexpected end reading number at ${pos}`);
    const negative = src[pos] === I;   // N=positive, I=negative
    pos++;
    const digits = [];
    while (pos < src.length && src[pos] !== S) {
        const c = src[pos];
        const d = _DIGITS.indexOf(c);
        if (d === -1) throw new Error(`[GhostVM] invalid digit U+${(c||'').codePointAt(0).toString(16)} at ${pos}`);
        digits.push(d);
        pos++;
    }
    pos++;   // consume S terminator
    let val = 0;
    for (const d of digits) val = val * 3 + d;
    return { val: negative ? -val : val, pos };
}

// ── Instruction parsing ───────────────────────────────────────────────────────
// Opcodes are S-terminated sequences of {N,J,I}. Parser reads content bits
// until S, then looks up the accumulated sequence in the opcode table.
// Numbers immediately follow opcodes that take args; they are also S-terminated.
// No greedy lookahead — S is always an unambiguous boundary.
const _OPCODE_TABLE = {
    // Stack
    [N+S]:         { op:'PUSH',     hasArg:true  },
    [N+N+S]:       { op:'DUP',      hasArg:false },
    [N+J+S]:       { op:'POP',      hasArg:false },
    [N+I+S]:       { op:'SWAP',     hasArg:false },
    [N+N+N+S]:     { op:'COPY',     hasArg:true  },
    [N+N+J+S]:     { op:'SLIDE',    hasArg:true  },
    // Arithmetic
    [J+N+S]:       { op:'ADD',      hasArg:false },
    [J+J+S]:       { op:'SUB',      hasArg:false },
    [J+I+S]:       { op:'MUL',      hasArg:false },
    [J+N+N+S]:     { op:'DIV',      hasArg:false },
    [J+N+J+S]:     { op:'MOD',      hasArg:false },
    // Flow
    [I+N+N+S]:     { op:'LABEL',    hasArg:true  },
    [I+N+J+S]:     { op:'CALL',     hasArg:true  },
    [I+N+I+S]:     { op:'JUMP',     hasArg:true  },
    [I+J+N+S]:     { op:'JZ',       hasArg:true  },
    [I+J+J+S]:     { op:'JN',       hasArg:true  },
    [I+J+I+S]:     { op:'RET',      hasArg:false },
    [I+I+S]:       { op:'END',      hasArg:false },
    // Heap / I/O
    [I+N+N+N+S]:   { op:'STORE',    hasArg:false },
    [I+N+N+J+S]:   { op:'RETRIEVE', hasArg:false },
    [I+I+N+S]:     { op:'OUT_CHAR', hasArg:false },
    [I+I+J+S]:     { op:'OUT_NUM',  hasArg:false },
    [I+I+I+S]:     { op:'IN_CHAR',  hasArg:false },
    [I+I+N+N+S]:   { op:'IN_NUM',   hasArg:false },
};

function parse(zwc) {
    const instrs = [];
    let pos = 0;

    while (pos < zwc.length) {
        // Accumulate content bits until S
        let key = '';
        while (pos < zwc.length && zwc[pos] !== S) key += zwc[pos++];
        if (pos >= zwc.length) throw new Error(`[GhostVM] unterminated opcode at end of input`);
        key += S;  // include the S terminator in the lookup key
        pos++;     // consume S

        const entry = _OPCODE_TABLE[key];
        if (!entry) throw new Error(`[GhostVM] unknown opcode sequence at pos ${pos - key.length}: ${[...key].map(c => 'U+'+c.codePointAt(0).toString(16)).join(' ')}`);

        if (entry.hasArg) {
            const r = decodeNumber(zwc, pos);
            instrs.push({ op: entry.op, arg: r.val });
            pos = r.pos;
        } else {
            instrs.push({ op: entry.op });
        }
    }

    return instrs;
}

// ─────────────────────────────────────────────────────────────────────────────
class GhostVM {
    constructor(opts = {}) {
        this.maxSteps = opts.maxSteps || 1_000_000;
    }

    // ── Execute ZWC source string ─────────────────────────────────────
    run(zwcSrc, inputStr = '') {
        const zwc    = extractZWC(zwcSrc);
        const instrs = parse(zwc);
        return this._exec(instrs, inputStr);
    }

    _exec(instrs, inputStr) {
        const stack     = [];
        const heap      = new Map();
        const callStack = [];
        const output    = [];
        const input     = [...(inputStr || '')];
        let   inputPos  = 0;

        const labels = new Map();
        instrs.forEach((instr, idx) => { if (instr.op === 'LABEL') labels.set(instr.arg, idx); });

        const pop  = () => { if (!stack.length) throw new Error('[GhostVM] stack underflow'); return stack.pop(); };
        const pop2 = () => { const b = pop(), a = pop(); return [a, b]; };
        const peek = () => { if (!stack.length) throw new Error('[GhostVM] stack underflow'); return stack[stack.length - 1]; };

        const jump = (label) => {
            const idx = labels.get(label);
            if (idx === undefined) throw new Error(`[GhostVM] undefined label ${label}`);
            pc = idx + 1;
        };

        const readChar = () => inputPos < input.length ? input[inputPos++].codePointAt(0) : 0;
        const readNum  = () => {
            const chars = [];
            while (inputPos < input.length && input[inputPos] !== '\n') chars.push(input[inputPos++]);
            inputPos++;
            return parseInt(chars.join(''), 10) || 0;
        };

        let pc    = 0;
        let steps = 0;

        while (pc < instrs.length) {
            if (++steps > this.maxSteps) throw new Error('[GhostVM] step limit exceeded');
            const { op, arg } = instrs[pc++];

            switch (op) {
                // ── Stack ──────────────────────────────────────────────
                case 'PUSH':  stack.push(arg); break;
                case 'DUP':   stack.push(peek()); break;
                case 'POP':   pop(); break;
                case 'SWAP':  { const [a, b] = pop2(); stack.push(b); stack.push(a); break; }
                case 'COPY':  {
                    const idx = stack.length - 1 - arg;
                    if (idx < 0) throw new Error('[GhostVM] COPY index out of range');
                    stack.push(stack[idx]); break;
                }
                case 'SLIDE': { const top = pop(); stack.splice(stack.length - arg, arg); stack.push(top); break; }

                // ── Arithmetic ─────────────────────────────────────────
                case 'ADD': { const [a,b]=pop2(); stack.push(a+b); break; }
                case 'SUB': { const [a,b]=pop2(); stack.push(a-b); break; }
                case 'MUL': { const [a,b]=pop2(); stack.push(a*b); break; }
                case 'DIV': { const [a,b]=pop2(); if (b===0) throw new Error('[GhostVM] division by zero'); stack.push(Math.trunc(a/b)); break; }
                case 'MOD': { const [a,b]=pop2(); if (b===0) throw new Error('[GhostVM] modulo by zero'); stack.push(((a%b)+b)%b); break; }

                // ── Flow ───────────────────────────────────────────────
                case 'LABEL': break;
                case 'CALL':  { callStack.push(pc); jump(arg); break; }
                case 'JUMP':  { jump(arg); break; }
                case 'JZ':    { const v=pop(); if (v===0) jump(arg); break; }
                case 'JN':    { const v=pop(); if (v<0)  jump(arg); break; }
                case 'RET':   { if (!callStack.length) throw new Error('[GhostVM] RET with empty call stack'); pc=callStack.pop(); break; }
                case 'END':   { pc = instrs.length; break; }

                // ── Heap ───────────────────────────────────────────────
                case 'STORE':    { const [val, addr]=pop2(); heap.set(addr, val); break; }
                case 'RETRIEVE': { const addr=pop(); const v=heap.get(addr); if (v===undefined) throw new Error(`[GhostVM] heap miss at ${addr}`); stack.push(v); break; }

                // ── I/O ────────────────────────────────────────────────
                case 'OUT_CHAR': output.push(String.fromCodePoint(pop())); break;
                case 'OUT_NUM':  output.push(String(pop())); break;
                case 'IN_CHAR':  { const addr=pop(); heap.set(addr, readChar()); break; }
                case 'IN_NUM':   { const addr=pop(); heap.set(addr, readNum()); break; }

                default: throw new Error(`[GhostVM] unknown op: ${op}`);
            }
        }

        return {
            output:  output.join(''),
            stack:   [...stack],
            heap:    Object.fromEntries(heap),
            steps,
        };
    }

    // ── Disassemble ZWC → Ghost Assembly text ─────────────────────────
    disassemble(zwcSrc) {
        const instrs = parse(extractZWC(zwcSrc));
        return instrs.map((instr, i) => {
            const arg = instr.arg !== undefined ? ` ${instr.arg}` : '';
            return `${String(i).padStart(4, '0')}  ${instr.op}${arg}`;
        }).join('\n');
    }

    // ── Assemble Ghost Assembly → ZWC IR ─────────────────────────────
    // Ghost Assembly format:
    //   push 42    ; push integer literal
    //   dup        ; duplicate top
    //   out_char   ; output as character
    //   end        ; terminate program
    assemble(asm) {
        const lines = asm.split('\n')
            .map(l => l.replace(/;.*/, '').trim())
            .filter(Boolean);

        let zwc = '';
        let labelCounter = 0;
        const labelMap = new Map();
        const label = name => {
            if (!labelMap.has(name)) labelMap.set(name, labelCounter++);
            return labelMap.get(name);
        };

        for (const line of lines) {
            const [mnem, ...rest] = line.split(/\s+/);
            const arg = rest.join(' ').trim();
            switch (mnem.toLowerCase()) {
                // Stack
                case 'push':     zwc += N+S           + encodeNumber(parseInt(arg, 10)); break;
                case 'dup':      zwc += N+N+S; break;
                case 'pop':      zwc += N+J+S; break;
                case 'swap':     zwc += N+I+S; break;
                case 'copy':     zwc += N+N+N+S       + encodeNumber(parseInt(arg, 10)); break;
                case 'slide':    zwc += N+N+J+S       + encodeNumber(parseInt(arg, 10)); break;
                // Arithmetic
                case 'add':      zwc += J+N+S; break;
                case 'sub':      zwc += J+J+S; break;
                case 'mul':      zwc += J+I+S; break;
                case 'div':      zwc += J+N+N+S; break;
                case 'mod':      zwc += J+N+J+S; break;
                // Flow
                case 'label':    zwc += I+N+N+S       + encodeNumber(label(arg)); break;
                case 'call':     zwc += I+N+J+S       + encodeNumber(label(arg)); break;
                case 'jump':     zwc += I+N+I+S       + encodeNumber(label(arg)); break;
                case 'jz':       zwc += I+J+N+S       + encodeNumber(label(arg)); break;
                case 'jn':       zwc += I+J+J+S       + encodeNumber(label(arg)); break;
                case 'ret':      zwc += I+J+I+S; break;
                case 'end':      zwc += I+I+S; break;
                // Heap / I/O
                case 'store':    zwc += I+N+N+N+S; break;
                case 'retrieve': zwc += I+N+N+J+S; break;
                case 'out_char': zwc += I+I+N+S; break;
                case 'out_num':  zwc += I+I+J+S; break;
                case 'in_char':  zwc += I+I+I+S; break;
                case 'in_num':   zwc += I+I+N+N+S; break;

                default: throw new Error(`[GhostVM] unknown mnemonic: ${mnem}`);
            }
        }
        return zwc;
    }

    // ── Run Ghost Assembly directly ───────────────────────────────────
    runAssembly(asm, input = '') {
        return this.run(this.assemble(asm), input);
    }

    // ── Static utilities ──────────────────────────────────────────────
    static ZWC        = ZWC;
    static encodeNumber = encodeNumber;
    static decodeNumber = decodeNumber;
    static extractZWC   = extractZWC;
    static parse        = parse;
}

module.exports = GhostVM;
