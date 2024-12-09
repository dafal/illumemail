require('dotenv').config(); // Load environment variables from .env file
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { simpleParser } = require('mailparser');
const puppeteer = require('puppeteer');
const winston = require('winston');

const app = express();

// Setup logging with Winston
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.json(),
    transports: [
        new winston.transports.Console()
    ],
});

// Multer configuration for file uploads
const upload = multer({
    dest: 'uploads/',
    limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB limit
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
                <div><strong>From:</strong> ${from}</div>
                <div><strong>To:</strong> ${to}</div>
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
    // Remove control characters, line breaks, and non-printable characters
    value = value.replace(/[\r\n\x00-\x1F\x7F]+/g, ' ').trim();

    // Replace non-ASCII characters with a placeholder or remove
    value = value.replace(/[^\x20-\x7E]/g, '');

    // Truncate to a reasonable length (e.g., 255 characters for safety)
    if (value.length > 255) {
        value = value.substring(0, 255) + '...';
    }

    return value;
}

// Endpoint to handle .eml file uploads and convert to JPEG
app.post('/convert', upload.single('eml_file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).send('No file uploaded.');
    }

    const inputFilePath = path.resolve(req.file.path);
    const outputFilePath = `${inputFilePath}.jpeg`;

    try {
        // Validate the file contents by attempting to parse it
        const parsedEmail = await simpleParser(fs.createReadStream(inputFilePath));

        // Ensure the parsed email contains expected fields
        if (!parsedEmail.text && !parsedEmail.html) {
            throw new Error('The uploaded file is not a valid .eml file.');
        }

        // Generate HTML from the email content
        const emailHtml = generateEmailHtml(parsedEmail);

        // Render HTML and take a screenshot
        const page = await browser.newPage();
        await page.setViewport({ width: 1024, height: 768 });
        await page.setContent(emailHtml, { waitUntil: 'networkidle0', timeout: 60000 });
        await page.screenshot({ path: outputFilePath, type: 'jpeg', fullPage: true });
        await page.close();

        // Extract message ID and log success
        const messageId = parsedEmail.messageId || 'Unknown';
        logger.info(`Successfully transformed email. Message ID: ${messageId}`);

        // Set sanitized metadata in the response headers
        res.setHeader('X-Email-Subject', sanitizeHeaderValue(parsedEmail.subject));
        res.setHeader('X-Email-From', sanitizeHeaderValue(parsedEmail.from?.text));
        res.setHeader('X-Message-ID', sanitizeHeaderValue(messageId));

        // Send the JPEG file as the response
        res.sendFile(outputFilePath, async (err) => {
            if (err) {
                logger.error('Error sending file:', err);
                res.status(500).send('Error sending file.');
            }

            // Clean up temporary files
            await fs.promises.unlink(inputFilePath);
            await fs.promises.unlink(outputFilePath);
        });
    } catch (err) {
        logger.error('Error processing file:', err.message);

        // Respond with appropriate error if the file isn't a valid .eml
        if (err.message === 'The uploaded file is not a valid .eml file.') {
            res.status(400).send('Invalid .eml file. Please upload a valid .eml file.');
        } else {
            res.status(500).send('Error processing file.');
        }

        // Clean up the uploaded file if validation fails
        await fs.promises.unlink(inputFilePath);
    }
});

// Server startup
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    logger.info(`Server is running on port ${PORT}`);
});