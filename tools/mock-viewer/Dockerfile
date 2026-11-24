# モックの閲覧のコンテナ。ビルドの文脈は npm run mock:up が tools/mock-viewer と docs/design/mock だけを tar で渡す
FROM node:24-alpine
WORKDIR /app
RUN printf '{"type":"module","private":true}\n' > package.json \
  && npm install --no-audit --no-fund --omit=dev playwright-core@1.65.1 \
  && npm cache clean --force
COPY tools/mock-viewer/src/ ./src/
COPY docs/design/mock/ /srv/mock/
USER node
ENV MOCK_ROOT=/srv/mock
CMD ["node", "src/viewer.ts"]
