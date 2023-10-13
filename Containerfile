####################################################################################################
# base
####################################################################################################

FROM docker.io/library/node:20 AS base

WORKDIR /app

COPY package.json yarn.lock .yarnrc.yml .
COPY .yarn .yarn


####################################################################################################
# build
####################################################################################################

FROM base AS build

WORKDIR /app

RUN yarn install --immutable

COPY . .

RUN yarn build


####################################################################################################
# runtime
####################################################################################################

FROM base AS runtime

WORKDIR /app

RUN yarn workspaces focus --all --production

COPY --from=build /app/dist dist

ENTRYPOINT [ "node", "dist/index.js" ]
