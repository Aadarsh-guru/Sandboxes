import { createServer } from 'http';
import { parseRequestBody, handleFS, runCommand, checkAuth } from './utils.js';

const SANDBOX_API_PORT = 80;
const SANDBOX_TIMEOUT = Number(process.env.SANDBOX_TIMEOUT || 60000); // default 1 min in ms

let shutdownTimer;

function scheduleShutdown(timeoutMs = SANDBOX_TIMEOUT) {
    if (shutdownTimer) clearTimeout(shutdownTimer);
    shutdownTimer = setTimeout(() => {
        console.log(`Sandbox server timeout reached (${timeoutMs / 60000} min). Shutting down.`);
        process.exit(0); // stop server
    }, timeoutMs);
}

// Initialize the shutdown timer
scheduleShutdown();

// Main HTTP server
const server = createServer(async (req, res) => {
    try {
        // Public health check endpoint
        if (req.method === 'GET' && req.url === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: true, data: 'ok' }));
        }

        // Handle /exec endpoint
        if (req.method === 'POST' && req.url === '/exec') {
            // Authorization check
            if (!checkAuth(req, res)) return;
            const { command, args, cwd, detached = false } = await parseRequestBody(req);
            if (!command) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({
                    success: false,
                    error: 'No command provided'
                }));
            }
            return runCommand({ command, args, cwd, res, detached: Boolean(detached) });
        }

        // Handle /fs endpoint
        if (req.method === 'POST' && req.url === '/fs') {
            // Authorization check
            if (!checkAuth(req, res)) return;
            const { action, path: filePath, content, targetPath } = await parseRequestBody(req);
            if (!action || !filePath) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({
                    success: false,
                    error: 'Action and path are required'
                }));
            }
            const result = await handleFS({ action, filePath, content, targetPath });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(result));
        }

        // Extend timeout endpoint
        if (req.method === 'POST' && req.url === '/extend-timeout') {
            // Authorization check
            if (!checkAuth(req, res)) return;
            const { durationMs } = await parseRequestBody(req);
            const parsedDuration = Number(durationMs);
            scheduleShutdown(Number.isFinite(parsedDuration) && parsedDuration > 0 ? parsedDuration : SANDBOX_TIMEOUT);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: true, data: 'Sandbox timeout extended' }));
        }

        // Stop server immediately
        if (req.method === 'POST' && req.url === '/stop') {
            // Authorization check
            if (!checkAuth(req, res)) return;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, data: 'Server stopping immediately' }));
            console.log('Server stopping manually via /stop route.');
            process.exit(0);
        }

        // If none of the above matched, return 404
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: false,
            error: 'Not found'
        }));

    } catch (err) {
        console.error('Server error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: false,
            error: err.message
        }));
    }
});

// Start server
server.listen(SANDBOX_API_PORT, () => {
    console.log(`Sandbox API server running on http://localhost:${SANDBOX_API_PORT}`);
});