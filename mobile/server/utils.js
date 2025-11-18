import path from 'path';
import { promises as fs } from 'fs';
import { spawn } from 'child_process';

const MAX_BODY_SIZE = 1e6; // 1 MB max request body
const SANDBOX_ROOT = '/app'; // Allowed directory for file operations
const SANDBOX_API_KEY = process.env.SANDBOX_API_KEY; // Sandbox API key

// Utility: check authorization header
export function checkAuth(req, res) {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token || token !== SANDBOX_API_KEY) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: false,
            error: 'Unauthorized'
        }));
        return false;
    }
    return true;
}

// Utility: sanitize paths to prevent directory traversal
export function sanitizePath(p = "") {
    const raw = typeof p === "string" ? p : "";
    const normalized = raw === "/" ? "" : raw.replace(/^\/+/g, "");
    const resolved = path.resolve(SANDBOX_ROOT, normalized);
    if (!resolved.startsWith(SANDBOX_ROOT)) {
        throw new Error('Access to this path is forbidden');
    }
    return resolved;
}

// Utility: join user cwd with SANDBOX_ROOT
function getSafeCwd(cwd = '') {
    // Join user cwd with SANDBOX_ROOT
    const normalizedCwd = cwd.replace(/^\/+/, '');
    const resolved = path.resolve(SANDBOX_ROOT, normalizedCwd);
    if (!resolved.startsWith(SANDBOX_ROOT)) {
        throw new Error('Access to this directory is forbidden');
    }
    return resolved;
}

// Utility: parse JSON safely
export async function parseRequestBody(req) {
    let body = '';
    for await (const chunk of req) {
        body += chunk;
        if (body.length > MAX_BODY_SIZE) {
            throw new Error('Request body too large');
        }
    }
    return JSON.parse(body || '{}');
}

// Execute shell command using spawn
export function runCommand({ command, args = [], cwd, res, detached = false }) {
    try {
        const child = spawn(command, args, {
            cwd: getSafeCwd(cwd),
            shell: true,
            detached,
        });
        // Send headers
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        // Utility to safely send a JSON chunk
        const sendChunk = (event, payload) => {
            res.write(JSON.stringify({ event, payload }) + '\n');
        };
        // Listen to stdout
        child.stdout.on('data', chunk => {
            process.stdout.write(chunk);
            sendChunk('stdout', chunk.toString());
        });
        // Listen to stderr
        child.stderr.on('data', chunk => {
            process.stderr.write(chunk);
            sendChunk('stderr', chunk.toString());
        });
        if (detached) {
            child.unref();
            sendChunk('exit', { exitCode: null });
            return res.end();
        }
        // On process exit
        child.on('close', code => {
            sendChunk('exit', { exitCode: code });
            res.end();
        });
        // On error
        child.on('error', err => {
            console.error('Process spawn error:', err);
            sendChunk('error', err.message);
            res.end();
        });
    } catch (err) {
        console.error('runCommand error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: false,
            error: err.message
        }));
    }
}

// File system operations handler
export async function handleFS({ action, filePath, content, targetPath }) {
    const fullPath = sanitizePath(filePath);
    const fullTargetPath = targetPath ? sanitizePath(targetPath) : null;
    switch (action) {
        case 'readFile':
            return { success: true, data: await fs.readFile(fullPath, 'utf-8') };
        case 'writeFile':
            await fs.writeFile(fullPath, content || '', 'utf-8');
            return { success: true, data: null };
        case 'deleteFile':
            await fs.unlink(fullPath);
            return { success: true, data: null };
        case 'mkdir':
            await fs.mkdir(fullPath, { recursive: true });
            return { success: true, data: null };
        case 'rmdir':
            await fs.rmdir(fullPath, { recursive: true });
            return { success: true, data: null };
        case 'ls':
            return {
                success: true,
                data: {
                    files: await fs.readdir(fullPath, { recursive: true })
                }
            };
        case 'rename':
            if (!fullTargetPath) throw new Error('Target path is required for rename');
            await fs.rename(fullPath, fullTargetPath);
            return { success: true, data: null };
        case 'copyFile':
            if (!fullTargetPath) throw new Error('Target path is required for copyFile');
            await fs.copyFile(fullPath, fullTargetPath);
            return { success: true, data: null };
        case 'stat':
            const stats = await fs.stat(fullPath);
            return {
                success: true,
                data: {
                    isFile: stats.isFile(),
                    isDirectory: stats.isDirectory(),
                    size: stats.size,
                    createdAt: stats.birthtime,
                    modifiedAt: stats.mtime
                }
            };
        default:
            throw new Error(`Unknown FS action: ${action}`);
    }
}