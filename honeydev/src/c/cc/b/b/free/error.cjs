'use strict';
// cc/b/b/free — bb-free: error schema / AST / stack unwind
// Defines the error type hierarchy for the cc-free surface.

const ErrorKind = Object.freeze({
    NETWORK:  'network',
    AUTH:     'auth',
    NOT_FOUND:'not_found',
    INTERNAL: 'internal',
});

class HdError extends Error {
    constructor(kind, message, meta = {}) {
        super(message);
        this.kind = kind;
        this.meta = meta;
    }
}

module.exports = { ErrorKind, HdError };
