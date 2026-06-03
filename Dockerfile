FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
ENV PORT=8080
EXPOSE 8080
# Runs the API via tsx (no separate build step).
CMD ["npm", "run", "start"]
