# 1. Use base Node.js image
FROM node:20-alpine

# 2 Enable corepack and install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# 3. Copy server into a hidden folder
COPY server/ /.server

# 4. Working dir is the template (main workspace)
WORKDIR /app

# 5. Copy template files into /app
COPY template/ .

# 6. Expose Expo dev port + API port
EXPOSE 8081 80

# 7. Start API server
CMD ["node", "/.server/index.js"]