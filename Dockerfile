# The always-on OnSite server (live phone calls over Twilio). Not used for the Lambda deployment.
FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
USER node
EXPOSE 3000
CMD ["node", "server.js"]
