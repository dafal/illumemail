require('dotenv').config(); // Load environment variables from .env file
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { simpleParser } = require('mailparser');
const puppeteer = require('puppeteer');
const winston = require('winston');
const stream = require('stream');

const app = express();

// Get log level and format from environment variables
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const LOG_FORMAT = process.env.LOG_FORMAT || 'json';

// Create custom formats for different output styles
const prettyFormat = winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message, ...metadata }) => {
        let msg = `${timestamp} [${level}]: ${message}`;
        if (Object.keys(metadata).length > 0) {
            msg += ` ${JSON.stringify(metadata)}`;
        }
        return msg;
    })
);

const simpleFormat = winston.format.combine(
    winston.format.timestamp({ format: 'HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) => {
        return `${timestamp} ${level.toUpperCase()}: ${message}`;
    })
);

const jsonFormat = winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
);

// Select format based on LOG_FORMAT environment variable
let selectedFormat;
switch (LOG_FORMAT.toLowerCase()) {
    case 'pretty':
        selectedFormat = prettyFormat;
        break;
    case 'simple':
        selectedFormat = simpleFormat;
        break;
    case 'json':
    default:
        selectedFormat = jsonFormat;
        break;
}

// Setup logging with Winston
const logger = winston.createLogger({
    level: LOG_LEVEL,
    format: selectedFormat,
    transports: [
        new winston.transports.Console()
    ],
});

// Log initialization
logger.info('Logger initialized', { logLevel: LOG_LEVEL, logFormat: LOG_FORMAT });

// Performance timing helper
function createTimer() {
    const start = Date.now();
    return {
        elapsed: () => Date.now() - start,
        log: (stage, metadata = {}) => {
            const duration = Date.now() - start;
            logger.debug('Stage timing', { stage, duration_ms: duration, ...metadata });
            return duration;
        }
    };
}

// Enable JSON payload parsing for API-like endpoint
app.use(express.json({ limit: '50mb' })); // Allow large JSON payloads

// Get maximum file size from environment variable or default to 20 MB
const MAX_FILE_SIZE_MB = process.env.MAX_FILE_SIZE_MB || 20;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

// Get maximum screenshot height to prevent massive images (in pixels)
const MAX_SCREENSHOT_HEIGHT = parseInt(process.env.MAX_SCREENSHOT_HEIGHT || '15000', 10);

// Offline mode: when enabled, block all outgoing network requests (remote images, fonts, etc.)
const OFFLINE_MODE = process.env.OFFLINE_MODE === '1';

// Accepts the usual truthy/falsy spellings so the flag behaves the same whether
// it arrives from the environment or a query string. Anything unrecognised
// (including undefined) falls back to the caller's default.
function parseBooleanFlag(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    const normalized = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return fallback;
}

// Attachment banner: renders the Outlook-style attachment strip above the
// message body. Off unless enabled, and overridable per request with
// ?attachment_banner=1 (or =0 to suppress it on an instance that defaults to on).
const ATTACHMENT_BANNER = parseBooleanFlag(process.env.ATTACHMENT_BANNER, false);

// Whether the banner also lists parts embedded in the HTML body (cid: images
// such as logos and signature graphics) alongside genuinely attached files.
// Off by default: those are already visible in the rendered body, and listing
// them buries the real attachments. Overridable per request with
// ?attachment_banner_inline=1.
const ATTACHMENT_BANNER_INLINE = parseBooleanFlag(process.env.ATTACHMENT_BANNER_INLINE, false);

// Multer configuration for file uploads
const upload = multer({
    dest: 'uploads/',
    limits: { fileSize: MAX_FILE_SIZE_BYTES }, // Dynamic file size limit
});

// Puppeteer setup
// Note: Chrome uses /dev/shm for shared memory and crashes ("Connection
// closed") when it runs out. Docker defaults /dev/shm to 64MB, so the
// container must be given a larger one (compose: shm_size; docker run:
// --shm-size=1g). We deliberately keep Chrome on the fast RAM-backed /dev/shm
// rather than passing --disable-dev-shm-usage, which would route shared memory
// to disk-backed /tmp and slow rendering. getBrowser() relaunches the browser
// if it ever does crash, so an undersized /dev/shm degrades instead of wedging.
const PUPPETEER_LAUNCH_OPTIONS = {
    // Use the system Chromium when PUPPETEER_EXECUTABLE_PATH is set (the Docker
    // image points this at /usr/bin/chromium so it works on amd64 and arm64).
    // When unset (e.g. local dev), fall back to Puppeteer's managed Chromium.
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
    ],
};

let browser;
let browserLaunchPromise;

async function launchBrowser() {
    const timer = createTimer();
    logger.debug('Launching Puppeteer browser');
    const instance = await puppeteer.launch(PUPPETEER_LAUNCH_OPTIONS);
    // If the browser process dies, drop the stale handle so the next request
    // relaunches it instead of failing forever with "Connection closed".
    instance.on('disconnected', () => {
        logger.error('Puppeteer browser disconnected; will relaunch on next request');
        browser = undefined;
        browserLaunchPromise = undefined;
    });
    logger.info('Puppeteer browser launched', { duration_ms: timer.elapsed() });
    return instance;
}

// Returns a connected browser, launching (or relaunching) one if needed. The
// in-flight promise is shared so concurrent requests don't launch duplicates.
async function getBrowser() {
    if (browser && browser.isConnected()) {
        return browser;
    }
    if (!browserLaunchPromise) {
        browserLaunchPromise = launchBrowser()
            .then((instance) => {
                browser = instance;
                return instance;
            })
            .catch((err) => {
                browserLaunchPromise = undefined;
                throw err;
            });
    }
    return browserLaunchPromise;
}

// Launch eagerly at startup so the first request doesn't pay the launch cost.
getBrowser().catch((err) => {
    logger.error('Initial Puppeteer browser launch failed', { error: err.message });
});

process.on('SIGINT', async () => {
    if (browser) await browser.close();
    process.exit();
});

// Function to escape HTML characters
function escapeHtml(unsafe) {
    return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// Human readable file size, matching the units Outlook shows in its
// attachment strip (KB for anything above a kilobyte).
function formatFileSize(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// Icon colour per file family, loosely following the Office/OneDrive palette so
// an analyst can recognise the attachment type at a glance. Executable and
// script types get the alert red.
const ATTACHMENT_COLORS = [
    { color: '#d13438', extensions: ['pdf'] },
    { color: '#2b579a', extensions: ['doc', 'docx', 'docm', 'dot', 'dotx', 'odt', 'rtf'] },
    { color: '#217346', extensions: ['xls', 'xlsx', 'xlsm', 'xlsb', 'ods', 'csv', 'tsv'] },
    { color: '#d24726', extensions: ['ppt', 'pptx', 'pptm', 'odp'] },
    { color: '#0078d4', extensions: ['eml', 'msg', 'ics', 'vcf'] },
    { color: '#8764b8', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'tif', 'tiff', 'webp', 'svg', 'heic'] },
    { color: '#c19c00', extensions: ['zip', 'rar', '7z', 'gz', 'tar', 'bz2', 'xz', 'cab', 'iso'] },
    { color: '#e37933', extensions: ['htm', 'html', 'xml', 'json'] },
    { color: '#a80000', extensions: ['exe', 'dll', 'bat', 'cmd', 'com', 'scr', 'ps1', 'vbs', 'js', 'jse', 'wsf', 'hta', 'jar', 'msi', 'lnk', 'iqy', 'reg'] },
];

const DEFAULT_ATTACHMENT_COLOR = '#5d5d5d';

function getAttachmentExtension(filename) {
    const match = /\.([A-Za-z0-9]{1,8})$/.exec(filename || '');
    return match ? match[1].toLowerCase() : '';
}

function getAttachmentColor(extension) {
    const entry = ATTACHMENT_COLORS.find((e) => e.extensions.includes(extension));
    return entry ? entry.color : DEFAULT_ATTACHMENT_COLOR;
}

// Inline SVG (no network access needed, so this also works in OFFLINE_MODE): a
// page with a folded corner and the extension printed across the bottom band.
function renderAttachmentIcon(extension) {
    const color = getAttachmentColor(extension);
    const label = escapeHtml((extension || '?').substring(0, 4).toUpperCase());
    // Shrink the label as it gets longer so 4 characters still fit the band.
    const fontSize = label.length >= 4 ? 7 : label.length === 3 ? 8 : 9;
    return `
        <svg class="attachment-icon" width="28" height="34" viewBox="0 0 28 34" aria-hidden="true">
            <path d="M2 2h16l8 8v22a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z" fill="#ffffff" stroke="#c8c6c4" stroke-width="1"/>
            <path d="M18 2l8 8h-8z" fill="#e6e6e6" stroke="#c8c6c4" stroke-width="1"/>
            <rect x="1" y="20" width="26" height="11" rx="1.5" fill="${color}"/>
            <text x="14" y="28" text-anchor="middle" font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="bold" fill="#ffffff">${label}</text>
        </svg>
    `;
}

// True for parts embedded in the HTML body (a cid: image, typically a logo or
// signature graphic) rather than genuinely attached files. mailparser sets
// related on parts the HTML actually references.
function isInlineAttachment(attachment) {
    return attachment.related === true || attachment.contentDisposition === 'inline';
}

// Outlook-style attachment strip. Lists genuinely attached files only; pass
// includeInline: true to also list parts embedded in the HTML body, which are
// then tagged so they can be told apart from real attachments.
function renderAttachments(parsedEmail, { includeInline = false } = {}) {
    const allAttachments = parsedEmail.attachments || [];
    const attachments = includeInline
        ? allAttachments
        : allAttachments.filter((attachment) => !isInlineAttachment(attachment));
    if (attachments.length === 0) return '';

    const items = attachments.map((attachment) => {
        const filename = attachment.filename || 'unnamed attachment';
        const extension = getAttachmentExtension(attachment.filename);
        const size = formatFileSize(attachment.size);
        const isInline = isInlineAttachment(attachment);

        return `
            <div class="attachment">
                ${renderAttachmentIcon(extension)}
                <div class="attachment-text">
                    <div class="attachment-name">${escapeHtml(filename)}${isInline ? '<span class="attachment-tag">inline</span>' : ''}</div>
                    ${size ? `<div class="attachment-size">${escapeHtml(size)}</div>` : ''}
                    ${attachment.contentType ? `<div class="attachment-type">${escapeHtml(attachment.contentType)}</div>` : ''}
                </div>
            </div>
        `;
    }).join('');

    return `
        <div class="attachments">
            <div class="attachments-title">Attachments (${attachments.length})</div>
            <div class="attachment-list">${items}</div>
        </div>
    `;
}

// Function to generate HTML from email content
function generateEmailHtml(parsedEmail, { showAttachmentBanner = false, includeInlineAttachments = false } = {}) {
    const messageId = escapeHtml(parsedEmail.messageId || 'Unknown');
    const from = parsedEmail.from?.text || 'Unknown Sender';
    const to = parsedEmail.to?.text || 'Unknown Recipient';
    const subject = parsedEmail.subject || 'No Subject';
    const htmlContent = parsedEmail.html || `<pre>${parsedEmail.text || 'No content available'}</pre>`;

    return `
        <html>
        <head>
            <meta charset="UTF-8">
            <style>
                body {
                    font-family: Arial, sans-serif;
                    line-height: 1.5;
                    margin: 20px;
                    overflow-wrap: break-word;
                    word-break: break-word;
                }
                pre {
                    white-space: pre-wrap;
                    overflow-wrap: break-word;
                    word-break: break-word;
                }
                .header {
                    margin-bottom: 20px;
                    padding: 10px;
                    background-color: #f9f9f9;
                    border: 1px solid #ddd;
                    border-radius: 5px;
                }
                .header div { 
                    margin: 5px 0; 
                }
                .content {
                    padding-top: 20px;
                    border-top: 1px solid #ddd;
                    margin-top: 20px;
                }
                .attachments {
                    margin-top: 12px;
                }
                .attachments-title {
                    font-size: 12px;
                    font-weight: bold;
                    color: #605e5c;
                    text-transform: uppercase;
                    letter-spacing: 0.4px;
                    margin-bottom: 6px;
                }
                .attachment-list {
                    display: grid;
                    grid-template-columns: repeat(auto-fill, 232px);
                    gap: 8px;
                }
                .attachment {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    padding: 6px 10px 6px 6px;
                    background-color: #fff;
                    border: 1px solid #ddd;
                    border-radius: 3px;
                }
                .attachment-icon {
                    flex: none;
                }
                .attachment-text {
                    min-width: 0;
                    line-height: 1.3;
                }
                .attachment-name {
                    font-size: 13px;
                    color: #201f1e;
                    overflow-wrap: anywhere;
                    word-break: break-word;
                }
                .attachment-size {
                    font-size: 11px;
                    color: #605e5c;
                }
                .attachment-type {
                    font-size: 10px;
                    color: #8a8886;
                    overflow-wrap: anywhere;
                }
                .attachment-tag {
                    margin-left: 6px;
                    padding: 0 4px;
                    font-size: 10px;
                    color: #605e5c;
                    background-color: #f3f2f1;
                    border: 1px solid #e1dfdd;
                    border-radius: 2px;
                    white-space: nowrap;
                }
            </style>
        </head>
        <body>
            <div class="header">
                <div><strong>Message ID:</strong> ${messageId}</div>
                <div><strong>From:</strong> ${from} <span class="email-address">(${parsedEmail.from?.value[0]?.address || 'Unknown'})</span></div>
                <div><strong>To:</strong> ${to} <span class="email-address">(${parsedEmail.to?.value[0]?.address || 'Unknown'})</span></div>
                <div><strong>Subject:</strong> ${subject}</div>
            </div>
            ${showAttachmentBanner ? renderAttachments(parsedEmail, { includeInline: includeInlineAttachments }) : ''}
            <div class="content">
                ${htmlContent}
            </div>
        </body>
        </html>
    `;
}

// Function to sanitize header values for HTTP headers
function sanitizeHeaderValue(value) {
    if (!value) return '';
    value = value.replace(/[\r\n\x00-\x1F\x7F]+/g, ' ').trim();
    value = value.replace(/[^\x20-\x7E]/g, '');
    if (value.length > 255) {
        value = value.substring(0, 255) + '...';
    }
    return value;
}

// Helper function to process email content
async function processEmailContent(emailContent, res, requestMetadata = {}, options = {}) {
    const showAttachmentBanner = options.showAttachmentBanner ?? ATTACHMENT_BANNER;
    const includeInlineAttachments = options.includeInlineAttachments ?? ATTACHMENT_BANNER_INLINE;
    const overallTimer = createTimer();
    const stageTimings = {};

    try {
        logger.debug('Starting email processing', requestMetadata);

        // Parse the email content
        const parseTimer = createTimer();
        logger.debug('Parsing email content');
        const parsedEmail = await simpleParser(emailContent);
        stageTimings.parsing = parseTimer.elapsed();

        const messageId = parsedEmail.messageId || 'Unknown';
        logger.debug('Email parsed successfully', {
            messageId,
            hasHtml: !!parsedEmail.html,
            hasText: !!parsedEmail.text,
            attachmentCount: (parsedEmail.attachments || []).length,
            from: parsedEmail.from?.text,
            to: parsedEmail.to?.text,
            subject: parsedEmail.subject,
            duration_ms: stageTimings.parsing
        });

        if (!parsedEmail.text && !parsedEmail.html) {
            throw new Error('The provided content is not a valid .eml file.');
        }

        // Generate HTML from the email content
        const htmlGenTimer = createTimer();
        const contentType = parsedEmail.html ? 'html' : 'text';
        const contentLength = (parsedEmail.html || parsedEmail.text || '').length;
        logger.debug('Generating HTML for rendering', {
            contentType,
            contentLength,
            showAttachmentBanner,
            includeInlineAttachments
        });

        const emailHtml = generateEmailHtml(parsedEmail, { showAttachmentBanner, includeInlineAttachments });
        stageTimings.htmlGeneration = htmlGenTimer.elapsed();
        logger.debug('HTML generated', {
            generatedHtmlLength: emailHtml.length,
            duration_ms: stageTimings.htmlGeneration
        });

        // Render HTML and take a screenshot
        const renderTimer = createTimer();
        logger.debug('Creating Puppeteer page');
        const browserInstance = await getBrowser();
        const page = await browserInstance.newPage();

        logger.debug('Setting viewport', { width: 1024, height: 0 });
        await page.setViewport({ width: 1024, height: 0 });

        // In offline mode, block all outgoing network requests
        if (OFFLINE_MODE) {
            await page.setRequestInterception(true);
            page.on('request', (request) => {
                const url = request.url();
                // Allow data URIs and inline content, block everything else
                if (url.startsWith('data:')) {
                    request.continue();
                } else {
                    logger.debug('Blocked outgoing request (offline mode)', { url });
                    request.abort('blockedbyclient');
                }
            });
        }

        logger.debug('Loading HTML content into page');
        await page.setContent(emailHtml, { waitUntil: OFFLINE_MODE ? 'load' : 'networkidle0', timeout: 60000 });

        // Get actual page dimensions, capping width to viewport
        const dimensions = await page.evaluate(() => {
            return {
                width: Math.min(document.documentElement.scrollWidth, 1024),
                height: document.documentElement.scrollHeight
            };
        });

        logger.debug('Page dimensions detected', {
            width: dimensions.width,
            height: dimensions.height,
            maxHeight: MAX_SCREENSHOT_HEIGHT
        });

        // Check if page height exceeds maximum
        let screenshotBuffer;
        let heightTruncated = false;

        if (dimensions.height > MAX_SCREENSHOT_HEIGHT) {
            logger.warn('Page height exceeds maximum, screenshot will be truncated', {
                actualHeight: dimensions.height,
                maxHeight: MAX_SCREENSHOT_HEIGHT,
                messageId
            });

            logger.debug('Taking truncated screenshot');
            screenshotBuffer = await page.screenshot({
                type: 'jpeg',
                clip: {
                    x: 0,
                    y: 0,
                    width: dimensions.width,
                    height: MAX_SCREENSHOT_HEIGHT
                }
            });
            heightTruncated = true;
        } else {
            logger.debug('Taking full page screenshot');
            screenshotBuffer = await page.screenshot({ type: 'jpeg', fullPage: true });
        }

        stageTimings.rendering = renderTimer.elapsed();

        logger.debug('Screenshot captured', {
            screenshotSize: screenshotBuffer.length,
            duration_ms: stageTimings.rendering,
            heightTruncated,
            capturedHeight: heightTruncated ? MAX_SCREENSHOT_HEIGHT : dimensions.height
        });

        await page.close();
        logger.debug('Puppeteer page closed');

        // Calculate total time
        stageTimings.total = overallTimer.elapsed();

        // Log success with full timing breakdown
        logger.info('Successfully transformed email', {
            messageId,
            attachmentCount: (parsedEmail.attachments || []).length,
            inlineAttachmentCount: (parsedEmail.attachments || []).filter(isInlineAttachment).length,
            showAttachmentBanner,
            includeInlineAttachments,
            timings: stageTimings,
            screenshotSize: screenshotBuffer.length,
            heightTruncated,
            pageHeight: dimensions.height,
            ...requestMetadata
        });

        // Set sanitized metadata in the response headers
        res.setHeader('X-Email-Subject', sanitizeHeaderValue(parsedEmail.subject));
        res.setHeader('X-Email-From', sanitizeHeaderValue(parsedEmail.from?.text));
        res.setHeader('X-Message-ID', sanitizeHeaderValue(messageId));
        res.setHeader('X-Screenshot-Height-Truncated', heightTruncated ? 'true' : 'false');
        if (heightTruncated) {
            res.setHeader('X-Actual-Page-Height', dimensions.height.toString());
            res.setHeader('X-Captured-Height', MAX_SCREENSHOT_HEIGHT.toString());
        }

        // Send the JPEG as the response
        res.setHeader('Content-Type', 'image/jpeg');
        res.send(screenshotBuffer);
    } catch (err) {
        stageTimings.total = overallTimer.elapsed();
        logger.error('Error processing email content', {
            error: err.message,
            stack: err.stack,
            timings: stageTimings,
            ...requestMetadata
        });
        res.status(400).send({ error: err.message });
    }
}

// Endpoint to handle .eml file uploads and convert to JPEG
app.post('/convert', upload.single('eml_file'), async (req, res) => {
    if (!req.file) {
        logger.warn('File upload request with no file');
        return res.status(400).send('No file uploaded.');
    }

    const inputFilePath = path.resolve(req.file.path);
    const showAttachmentBanner = parseBooleanFlag(req.query.attachment_banner, ATTACHMENT_BANNER);
    const includeInlineAttachments = parseBooleanFlag(req.query.attachment_banner_inline, ATTACHMENT_BANNER_INLINE);
    const requestMetadata = {
        endpoint: '/convert',
        fileName: req.file.originalname,
        fileSize: req.file.size,
        mimeType: req.file.mimetype
    };

    logger.info('Received file upload request', requestMetadata);

    try {
        const emailContent = fs.createReadStream(inputFilePath);
        await processEmailContent(emailContent, res, requestMetadata, { showAttachmentBanner, includeInlineAttachments });
    } finally {
        // Clean up uploaded file
        logger.debug('Cleaning up uploaded file', { filePath: inputFilePath });
        await fs.promises.unlink(inputFilePath);
        logger.debug('Uploaded file deleted', { filePath: inputFilePath });
    }
});

// New endpoint to handle JSON API-like requests with base64-encoded content
app.post('/convert-api', async (req, res) => {
    const { eml_content } = req.body;
    if (!eml_content) {
        logger.warn('API request with no eml_content');
        return res.status(400).send({ error: 'No .eml content provided.' });
    }

    // Query string wins over the JSON body, which wins over the env default.
    const showAttachmentBanner = parseBooleanFlag(
        req.query.attachment_banner,
        parseBooleanFlag(req.body.attachment_banner, ATTACHMENT_BANNER)
    );
    const includeInlineAttachments = parseBooleanFlag(
        req.query.attachment_banner_inline,
        parseBooleanFlag(req.body.attachment_banner_inline, ATTACHMENT_BANNER_INLINE)
    );
    const requestMetadata = {
        endpoint: '/convert-api',
        encodedContentLength: eml_content.length
    };

    logger.info('Received API request with base64 content', requestMetadata);

    try {
        // Decode base64-encoded content
        logger.debug('Decoding base64 content');
        const decodedContent = Buffer.from(eml_content, 'base64');
        requestMetadata.decodedContentSize = decodedContent.length;

        logger.debug('Base64 content decoded', {
            decodedSize: decodedContent.length
        });

        // Convert the decoded content to a readable stream
        const emailContentStream = new stream.PassThrough();
        emailContentStream.end(decodedContent);

        await processEmailContent(emailContentStream, res, requestMetadata, { showAttachmentBanner, includeInlineAttachments });
    } catch (err) {
        logger.error('Error decoding base64 content', {
            error: err.message,
            stack: err.stack,
            ...requestMetadata
        });
        res.status(400).send({ error: 'Invalid base64-encoded content.' });
    }
});

// Ping endpoint
app.get('/ping', (req, res) => {
    res.send('pong');
});

// Health check endpoint: reports unhealthy if the browser isn't connected so
// the container orchestrator (Docker HEALTHCHECK) can restart the service.
app.get('/health', (req, res) => {
    const browserConnected = !!(browser && browser.isConnected());
    if (browserConnected) {
        return res.json({ status: 'ok', browser: 'connected' });
    }
    logger.warn('Health check failed: browser not connected');
    res.status(503).json({ status: 'unhealthy', browser: 'disconnected' });
});

// Server startup
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    logger.info('Server started successfully', {
        port: PORT,
        maxFileSizeMB: MAX_FILE_SIZE_MB,
        maxScreenshotHeight: MAX_SCREENSHOT_HEIGHT,
        offlineMode: OFFLINE_MODE,
        attachmentBanner: ATTACHMENT_BANNER,
        attachmentBannerInline: ATTACHMENT_BANNER_INLINE,
        logLevel: LOG_LEVEL,
        logFormat: LOG_FORMAT,
        endpoints: ['/convert', '/convert-api', '/ping', '/health']
    });
});