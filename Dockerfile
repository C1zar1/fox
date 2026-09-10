FROM node:24-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
RUN npx prisma generate
EXPOSE 3000
CMD ["node","src/index.js"]
