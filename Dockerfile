FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENV PORT=8080 NODE_ENV=production
EXPOSE 8080
# Bootstraps the DB role, runs migrations, seeds the demo corpus (idempotent),
# then serves the API + static frontend via tsx (no separate build step).
CMD ["npm", "run", "start:prod"]
