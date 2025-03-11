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

// Setup logging with Winston
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.json(),
    transports: [
        new winston.transports.Console()
    ],
});

// Enable JSON payload parsing for API-like endpoint
app.use(express.json({ limit: '50mb' })); // Allow large JSON payloads

// Get maximum file size from environment variable or default to 20 MB
const MAX_FILE_SIZE_MB = process.env.MAX_FILE_SIZE_MB || 20;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

// Multer configuration for file uploads
const upload = multer({
    dest: 'uploads/',
    limits: { fileSize: MAX_FILE_SIZE_BYTES }, // Dynamic file size limit
});

// Puppeteer setup
let browser;
(async () => {
    browser = await puppeteer.launch({
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    logger.info('Puppeteer browser launched');
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
async function processEmailContent(emailContent, res) {
    try {
        // Parse the email content
        const parsedEmail = await simpleParser(emailContent);

        if (!parsedEmail.text && !parsedEmail.html) {
            throw new Error('The provided content is not a valid .eml file.');
        }

        // Generate HTML from the email content
        const emailHtml = generateEmailHtml(parsedEmail);

        // Render HTML and take a screenshot
        const page = await browser.newPage();
        await page.setViewport({ width: 1024, height: 0 }); // Restrict width to 1024px, height auto
        await page.setContent(emailHtml, { waitUntil: 'networkidle0', timeout: 60000 });
        const screenshotBuffer = await page.screenshot({ type: 'jpeg', fullPage: true });
        await page.close();

        // Extract message ID and log success
        const messageId = parsedEmail.messageId || 'Unknown';
        logger.info(`Successfully transformed email. Message ID: ${messageId}`);

        // Set sanitized metadata in the response headers
        res.setHeader('X-Email-Subject', sanitizeHeaderValue(parsedEmail.subject));
        res.setHeader('X-Email-From', sanitizeHeaderValue(parsedEmail.from?.text));
        res.setHeader('X-Message-ID', sanitizeHeaderValue(messageId));

        // Send the JPEG as the response
        res.setHeader('Content-Type', 'image/jpeg');
        res.send(screenshotBuffer);
    } catch (err) {
        logger.error('Error processing email content:', err.message);
        res.status(400).send({ error: err.message });
    }
}

// Endpoint to handle .eml file uploads and convert to JPEG
app.post('/convert', upload.single('eml_file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).send('No file uploaded.');
    }
    const inputFilePath = path.resolve(req.file.path);
    try {
        const emailContent = fs.createReadStream(inputFilePath);
        await processEmailContent(emailContent, res);
    } finally {
        // Clean up uploaded file
        await fs.promises.unlink(inputFilePath);
    }
});

// New endpoint to handle JSON API-like requests with base64-encoded content
app.post('/convert-api', async (req, res) => {
    const { eml_content } = req.body;
    if (!eml_content) {
        return res.status(400).send({ error: 'No .eml content provided.' });
    }

    try {
        // Decode base64-encoded content
        const decodedContent = Buffer.from(eml_content, 'base64');

        // Convert the decoded content to a readable stream
        const emailContentStream = new stream.PassThrough();
        emailContentStream.end(decodedContent);

        await processEmailContent(emailContentStream, res);
    } catch (err) {
        logger.error('Error decoding base64 content:', err.message);
        res.status(400).send({ error: 'Invalid base64-encoded content.' });
    }
});

// Server startup
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    logger.info(`Server is running on port ${PORT}`);
});