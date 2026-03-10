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

// Multer configuration for file uploads
const upload = multer({
    dest: 'uploads/',
    limits: { fileSize: MAX_FILE_SIZE_BYTES }, // Dynamic file size limit
});

// Puppeteer setup
let browser;
(async () => {
    const timer = createTimer();
    logger.debug('Launching Puppeteer browser');
    browser = await puppeteer.launch({
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    logger.info('Puppeteer browser launched', { duration_ms: timer.elapsed() });
})();

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

// Function to generate HTML from email content
function generateEmailHtml(parsedEmail) {
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
            </style>
        </head>
        <body>
            <div class="header">
                <div><strong>Message ID:</strong> ${messageId}</div>
                <div><strong>From:</strong> ${from} <span class="email-address">(${parsedEmail.from?.value[0]?.address || 'Unknown'})</span></div>
                <div><strong>To:</strong> ${to} <span class="email-address">(${parsedEmail.to?.value[0]?.address || 'Unknown'})</span></div>
                <div><strong>Subject:</strong> ${subject}</div>
            </div>
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
async function processEmailContent(emailContent, res, requestMetadata = {}) {
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
        logger.debug('Generating HTML for rendering', { contentType, contentLength });

        const emailHtml = generateEmailHtml(parsedEmail);
        stageTimings.htmlGeneration = htmlGenTimer.elapsed();
        logger.debug('HTML generated', {
            generatedHtmlLength: emailHtml.length,
            duration_ms: stageTimings.htmlGeneration
        });

        // Render HTML and take a screenshot
        const renderTimer = createTimer();
        logger.debug('Creating Puppeteer page');
        const page = await browser.newPage();

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
    const requestMetadata = {
        endpoint: '/convert',
        fileName: req.file.originalname,
        fileSize: req.file.size,
        mimeType: req.file.mimetype
    };

    logger.info('Received file upload request', requestMetadata);

    try {
        const emailContent = fs.createReadStream(inputFilePath);
        await processEmailContent(emailContent, res, requestMetadata);
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

        await processEmailContent(emailContentStream, res, requestMetadata);
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

// Server startup
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    logger.info('Server started successfully', {
        port: PORT,
        maxFileSizeMB: MAX_FILE_SIZE_MB,
        maxScreenshotHeight: MAX_SCREENSHOT_HEIGHT,
        offlineMode: OFFLINE_MODE,
        logLevel: LOG_LEVEL,
        logFormat: LOG_FORMAT,
        endpoints: ['/convert', '/convert-api', '/ping']
    });
});