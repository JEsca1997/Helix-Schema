'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  HelixApp/preload.js — Electron context bridge
//  cc frame · m/m layer · free tier
//
//  Exposes a safe, minimal API surface to the renderer (HelixIDE.html).
//  All calls go through IPC to the main process — no Node.js in renderer.
// ─────────────────────────────────────────────────────────────────────────────

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('helix', {

    // ── dep.jl key read ───────────────────────────────────────────────
    dep: (key) => ipcRenderer.invoke('helix:dep', key),

    // ── Full Helix source pipeline ────────────────────────────────────
    // opts: { stopAt, input, maxSteps }
    pipeline: (source, opts = {}) =>
        ipcRenderer.invoke('helix:pipeline', {
            source,
            stopAt:   opts.stopAt   || 'executed',
            input:    opts.input    || '',
            maxSteps: opts.maxSteps || 1_000_000,
        }),

    // ── Ghost ZWC utilities ───────────────────────────────────────────
    ghost: {
        assemble:    (asm)         => ipcRenderer.invoke('helix:ghost:assemble', asm),
        disassemble: (zwc)         => ipcRenderer.invoke('helix:ghost:disassemble', zwc),
        run:         (asm, input)  => ipcRenderer.invoke('helix:ghost:run', { asm, input }),
    },

    // ── File I/O ──────────────────────────────────────────────────────
    openFile: ()                   => ipcRenderer.invoke('helix:open-file'),
    saveFile: (filePath, content)  => ipcRenderer.invoke('helix:save-file', { filePath, content }),

    // ── File system / DM browsing ─────────────────────────────────────
    drives:           ()        => ipcRenderer.invoke('helix:drives'),
    dmChildren:       (absPath) => ipcRenderer.invoke('helix:dm:children', absPath),
    dmGrep:           (pattern) => ipcRenderer.invoke('helix:dm:grep', pattern),

    // ── Auth ──────────────────────────────────────────────────────────
    authSession:       ()                             => ipcRenderer.invoke('helix:auth:session'),
    authLogin:         (accountName, password)        => ipcRenderer.invoke('helix:auth:login',          { accountName, password }),
    authLogout:        ()                             => ipcRenderer.invoke('helix:auth:logout'),
    authCreateAccount: (accountName, email, password, adPerLoad, adInterval) => ipcRenderer.invoke('helix:auth:create-account', { accountName, email, password, adPerLoad, adInterval }),

    // ── Ghost K2 access control ───────────────────────────────────────
    // Validate a path/frame against the io_calculus Klein-4 routing table.
    ghostK2: (path, k4) => ipcRenderer.invoke('helix:ghost:k2', { path, k4 }),

    // ── Self-distribution ─────────────────────────────────────────────
    // Download the currently-running helix.exe (save-as dialog).
    downloadSelf: () => ipcRenderer.invoke('helix:download-self'),
});
