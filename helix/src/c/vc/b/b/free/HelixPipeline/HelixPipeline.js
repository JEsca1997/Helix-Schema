'use strict';

// ── dep.jl + DirectoryManager ─────────────────────────────────────────────────
const _DEP_JL = process.env.HELIX_DEP  || 'F:/helix/.helix/dep.jl';
const _JULIA  = process.env.HELIX_JULIA || 'julia';
const { execFileSync } = require('child_process');

function _dep(key) {
    const v = execFileSync(_JULIA, [_DEP_JL, 'get', key], { encoding: 'utf8' }).trim();
    if (!v || v === 'not found') throw new Error(`[HelixPipeline] dep.jl missing: ${key}`);
    return v;
}
let _DM_PATH;
function _dmResolve(name) {
    if (!_DM_PATH) _DM_PATH = _dep('HELIX_DM');
    const raw = execFileSync(_JULIA, [_DM_PATH, 'grep', name], { encoding: 'utf8' }).trim();
    const lines = raw.split('\n').map(l => l.trim())
        .filter(l => l && !l.startsWith('[DM]') && !l.startsWith('grep '));
    const match = lines.find(l => l.split(/[\\/]/).pop() === name) || lines[0];
    if (!match) throw new Error(`[HelixPipeline] DM could not resolve: ${name}`);
    return match;
}

// ─────────────────────────────────────────────────────────────────────────────
//  HelixPipeline — source code → Ghost ZWC → execution orchestrator
//  vc frame · b/b layer · free tier
//
//  Pipeline stages (each can be inspected independently via stopAt):
//    tokens    → helix_tokenizer.cjs     source → token stream
//    ast       → helix_parser.cjs        tokens → AST
//    validated → helix_ast_validator.cjs AST    → semantic analysis
//    typed     → HelixTypeSystem.js      AST    → type annotations
//    compiled  → helix_transpiler.cjs    AST    → Ghost ZWC IR
//    executed  → GhostVM.js              ZWC    → output + VM state
//
//  All component paths resolved via DirectoryManager at first use.
//  k4 tier propagated to TypeSystem so D^α encoding is tier-aware.
// ─────────────────────────────────────────────────────────────────────────────

class HelixPipeline {
    constructor(opts = {}) {
        this.tier = opts.tier || process.env.HELIX_TIER || 'free';
        this.k4   = opts.k4   || process.env.HELIX_K4   || '00';
        // Lazy-loaded component cache
        this._mods = {};
    }

    _load(key, fileName) {
        if (!this._mods[key]) this._mods[key] = require(_dmResolve(fileName));
        return this._mods[key];
    }

    _Tokenizer()  { return this._load('tokenizer',  'helix_tokenizer.cjs'); }
    _Parser()     { return this._load('parser',     'helix_parser.cjs'); }
    _Validator()  { return this._load('validator',  'helix_ast_validator.cjs'); }
    _TypeSystem() { return this._load('typeSystem', 'HelixTypeSystem.js'); }
    _Transpiler() { return this._load('transpiler', 'helix_transpiler.cjs'); }
    _GhostVM()    { return this._load('ghostVM',    'GhostVM.js'); }

    // ─────────────────────────────────────────────────────────────────
    //  run(source, opts)
    //  opts.stopAt    — stage name to stop after (default: 'executed')
    //  opts.input     — stdin string for GhostVM execution
    //  opts.maxSteps  — GhostVM step cap (default: 1_000_000)
    //  opts.haltOnError — stop at first validation error (default: true)
    //
    //  Returns { source, tier, k4, stages: { tokens, ast, validated,
    //            typed, compiled, executed, errors? } }
    // ─────────────────────────────────────────────────────────────────
    async run(source, opts = {}) {
        const stopAt = opts.stopAt || 'executed';
        const result = {
            source,
            tier:   this.tier,
            k4:     this.k4,
            stages: {},
        };

        // ── Stage 1: Tokenize ─────────────────────────────────────────
        try {
            const Tokenizer = this._Tokenizer();
            const tok = typeof Tokenizer === 'function'
                ? new Tokenizer(source)
                : Tokenizer;
            result.stages.tokens = tok.tokenize
                ? tok.tokenize()
                : tok.scan
                    ? tok.scan()
                    : Tokenizer(source);
        } catch (e) {
            result.stages.tokenizeError = e.message;
            return result;
        }
        if (stopAt === 'tokens') return result;

        // ── Stage 2: Parse ────────────────────────────────────────────
        try {
            const Parser = this._Parser();
            const p = typeof Parser === 'function'
                ? new Parser(result.stages.tokens, source)
                : Parser;
            result.stages.ast = p.parse
                ? p.parse()
                : Parser(result.stages.tokens);
        } catch (e) {
            result.stages.parseError = e.message;
            return result;
        }
        if (stopAt === 'ast') return result;

        // ── Stage 3: Validate ─────────────────────────────────────────
        try {
            const Validator = this._Validator();
            const v = typeof Validator === 'function'
                ? new Validator(result.stages.ast)
                : Validator;
            const validated = v.validate
                ? v.validate()
                : v.analyze
                    ? v.analyze()
                    : { ast: result.stages.ast, errors: [] };
            result.stages.validated = validated;
            result.stages.errors    = validated.errors || [];
        } catch (e) {
            result.stages.validateError = e.message;
            result.stages.errors = [{ message: e.message }];
        }
        if (result.stages.errors?.length && opts.haltOnError !== false) return result;
        if (stopAt === 'validated') return result;

        // ── Stage 4: Type check ───────────────────────────────────────
        const astForType = result.stages.validated?.ast || result.stages.ast;
        try {
            const TypeSystem = this._TypeSystem();
            const ts = typeof TypeSystem === 'function'
                ? new TypeSystem(this.k4)
                : TypeSystem;
            result.stages.typed = ts.check
                ? ts.check(astForType)
                : ts.infer
                    ? ts.infer(astForType)
                    : astForType;
        } catch (e) {
            result.stages.typeError = e.message;
            result.stages.typed     = astForType;
        }
        if (stopAt === 'typed') return result;

        // ── Stage 5: Transpile → Ghost ZWC IR ────────────────────────
        const astForCompile = result.stages.typed || astForType;
        try {
            const Transpiler = this._Transpiler();
            const tx = typeof Transpiler === 'function'
                ? new Transpiler(astForCompile, { tier: this.tier, k4: this.k4 })
                : Transpiler;
            result.stages.compiled = tx.transpile
                ? await tx.transpile()
                : tx.compile
                    ? tx.compile()
                    : Transpiler(astForCompile);
        } catch (e) {
            result.stages.compileError = e.message;
            return result;
        }
        if (stopAt === 'compiled') return result;

        // ── Stage 6: Execute in GhostVM ───────────────────────────────
        try {
            const GhostVM = this._GhostVM();
            const vm = new GhostVM({ maxSteps: opts.maxSteps || 1_000_000 });
            result.stages.executed = vm.run(result.stages.compiled, opts.input || '');
        } catch (e) {
            result.stages.runtimeError = e.message;
        }
        return result;
    }

    // ── Convenience shorthands ────────────────────────────────────────
    tokenize(source)              { return this.run(source, { stopAt: 'tokens' }); }
    parse(source)                 { return this.run(source, { stopAt: 'ast' }); }
    compile(source)               { return this.run(source, { stopAt: 'compiled' }); }
    execute(source, input = '')   { return this.run(source, { stopAt: 'executed', input }); }

    // ── Run raw Ghost Assembly (bypasses Helix tokenizer/parser) ─────
    runAssembly(asm, input = '') {
        const GhostVM = this._GhostVM();
        const vm = new GhostVM();
        const zwc = vm.assemble(asm);
        const out = vm.run(zwc, input);
        return {
            source: asm, tier: this.tier, k4: this.k4,
            stages: { compiled: zwc, executed: out },
        };
    }
}

module.exports = HelixPipeline;
