# One container: the backend, serving the built glasses app from the same origin.
FROM node:22-slim AS app
WORKDIR /src
COPY shared ./shared
COPY app/package.json app/package-lock.json ./app/
RUN cd app && npm ci
COPY app ./app
ARG VITE_API_BASE
RUN cd app && VITE_API_BASE=$VITE_API_BASE npm run build

FROM node:22-slim
WORKDIR /src/server
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY shared /src/shared
COPY server ./
COPY site ./public
COPY --from=app /src/app/dist ./public/app
RUN mkdir -p data && chown node data
USER node
ENV STATIC_DIR=./public DB_PATH=./data/glasses.db PORT=8790
EXPOSE 8790
CMD ["node", "--import", "tsx", "main.ts"]
