ARG BUILD_FROM
FROM ${BUILD_FROM}

RUN apk add --no-cache git npm

COPY . /
RUN chmod a+x /run.sh
RUN chmod a+x /finish.sh

RUN rm -rf node_modules package-lock.json && npm install -f

EXPOSE 3000
CMD [ "/run.sh" ]
