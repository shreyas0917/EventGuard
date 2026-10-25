FROM node:20-alpine

WORKDIR /app

# Copy root workspace files
COPY package*.json ./

# Copy frontend workspace
COPY frontend ./frontend

# Install dependencies using root workspace
RUN npm ci --workspaces

WORKDIR /app/frontend

EXPOSE 5173

CMD ["npm", "run", "dev"]
