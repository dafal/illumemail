# **Illumemail**

Illumemail is a lightweight Node.js-based service that converts `.eml` email files into JPEG images. This project leverages Large Language Models  to expedite the development process. The generated code is optimized for deployment in Docker and offers a seamless approach to rendering email content for visualisation or archival purposes.

---

## **Features**

- Parse and render `.eml` files into visually accurate JPEG images.
- Includes essential email metadata such as `Message-ID`, `From`, `To`, and `Subject` in the rendered image.
- Fully Dockerized for easy deployment.
- Security-focused, running as a non-root user inside the container.

---

## **Getting Started**

### **Prerequisites**
- **Docker**: Ensure Docker is installed on your system. [Install Docker](https://docs.docker.com/get-docker/)

---

### **Installation**

1. Clone the repository:
```bash
   git clone https://github.com/your-repo/illumemail.git
   cd illumemail
```

2. Build the Docker image:
```bash
docker build -t illumemail .
```
3. Run the Docker container:
```bash
docker run -p 5000:5000 illumemail
```

### Usage
**Upload an .eml File**
To convert an .eml file to a JPEG, send a POST request to the /convert endpoint with the .eml file as a multipart upload.
**Example with curl:**
Using multipart-form:
```bash
curl -X POST -F "eml_file=@sample.eml" http://localhost:5000/convert --output output.jpeg
```

Using api endpoint:
```bash
base64 sample.eml > encoded_file.txt
curl -X POST http://localhost:5000/convert-api \
-H "Content-Type: application/json" \
-d @- <<EOF > output.jpeg
{
  "eml_content": "$(cat encoded_file.txt)"
}
EOF
```
**Response**
- On success, the service returns the rendered JPEG image as the response.
- Metadata such as Message-ID, Subject, and From are included as HTTP response headers.
**Environment Variables**

| Variable | Default | Description |
| -------- | ------- | ----------- |
| PORT | 5000 | Port on which the application runs. |
| MAX_FILE_SIZE_MB | 20 | Maximum file size (in MB) for uploaded .eml files. |
| MAX_SCREENSHOT_HEIGHT | 15000 | Maximum height (in pixels) for generated screenshots. Prevents memory issues with very long emails. |
| LOG_LEVEL | info | Logging verbosity level: `error`, `warn`, `info`, `debug`. |
| LOG_FORMAT | json | Log output format: `json` (structured), `pretty` (colorized with metadata), `simple` (minimal). |

## Development
To run the application locally:
1. Install dependencies:
```bash
npm install
```
2. Start the application:
```bash
node server.js
```
3. Access the service at http://localhost:5000.

### Debug and Logging
Illumemail includes comprehensive logging capabilities to help troubleshoot issues and monitor performance:

**Log Levels:**
- `error` - Only critical errors
- `warn` - Warnings and errors
- `info` - General information (default) - includes request summaries and completion status
- `debug` - Detailed debugging information including:
  - Email parsing details (metadata extraction)
  - HTML generation steps
  - Puppeteer operations (page creation, rendering, screenshots)
  - Performance timing for each stage
  - File cleanup operations

**Log Formats:**
- `json` (default) - Structured JSON format, ideal for log aggregation tools
- `pretty` - Colorized output with metadata, best for development
- `simple` - Minimal console output, easiest to read

**Usage Examples:**

Enable debug logging with pretty format during development:
```bash
LOG_LEVEL=debug LOG_FORMAT=pretty node server.js
```

Production logging with structured JSON:
```bash
LOG_LEVEL=info LOG_FORMAT=json node server.js
```

Using Docker with debug logging:
```bash
docker run -p 5000:5000 -e LOG_LEVEL=debug -e LOG_FORMAT=pretty illumemail
```

**What Gets Logged:**

At `info` level:
- Server startup configuration
- Incoming requests (file size, endpoint)
- Processing completion with timing breakdown
- Error messages

At `warn` level (warnings):
- Screenshot height truncation (when emails exceed MAX_SCREENSHOT_HEIGHT)

At `debug` level (everything above plus):
- Email parsing progress and extracted metadata
- HTML generation details (content type, lengths)
- Page dimensions (width/height)
- Puppeteer step-by-step operations
- Screenshot capture details
- File cleanup operations
- Performance timing for each pipeline stage

**Response Headers:**
When a screenshot is truncated due to height limit, the following headers are included:
- `X-Screenshot-Height-Truncated: true`
- `X-Actual-Page-Height: [pixels]` - The actual email height
- `X-Captured-Height: [pixels]` - The maximum captured height

## Docker Compose (Optional)
Create a docker-compose.yml file to simplify deployment:
```yaml
version: '3.8'

services:
  illumemail:
    image: illumemail
    ports:
      - "5001:5000"
    volumes:
      - ./uploads:/usr/src/app/uploads
```
Start the application:
```bash
docker-compose up
```


## Known Limitations
- Supports only .eml files for input (no msg).
- Rendering relies on Puppeteer, so ensure the necessary dependencies are available.

## Contributing
Contributions are welcome! To contribute:
1. Fork the repository.
2. Create a feature branch.
3. Submit a pull request.

## License
Illumemail is released under the MIT License.

## Contact
For support or inquiries, contact:
Eric Daras
eric@daras.family
