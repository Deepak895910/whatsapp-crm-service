FROM node:18-alpine

WORKDIR /app

RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    git

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    PORT=10000

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 10000

CMD ["npm", "start"]
