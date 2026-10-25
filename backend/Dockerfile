FROM node:20-alpine

# Install OpenSSL compatibility library required by Prisma 5.20.0 engine
RUN apk add --no-cache openssl

WORKDIR /app

# Copy root workspace files
COPY package*.json ./

# Copy backend workspace
COPY backend ./backend

# Install dependencies using root workspace
RUN npm ci --workspaces

WORKDIR /app/backend

# Generate Prisma Client during image build so container starts without manual generate
RUN npx prisma generate

EXPOSE 3001

COPY backend/start.sh ./start.sh
RUN chmod +x ./start.sh

CMD ["./start.sh"]
