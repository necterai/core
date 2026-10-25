# necter collector: the hosted script, beacon endpoint, dashboard and optional proxy.
#   docker build -t necter .
#   docker run -p 8788:8788 -v necter-data:/app/apps/collector/data necter
#   docker run -p 8788:8788 -e UPSTREAM=https://your-site.com necter     # proxy mode
FROM node:24-slim
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --filter "@necterai/collector..." --filter necter \
 && pnpm --filter "./packages/**" run build
ENV HOST=0.0.0.0 PORT=8788 NECTER_MODE=monitor
EXPOSE 8788
CMD ["pnpm", "--filter", "@necterai/collector", "run", "start"]
