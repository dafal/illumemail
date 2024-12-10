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
| MAX_FILE_SIZE_MB | 20 | Maximum file size |
|  |  |  |

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
