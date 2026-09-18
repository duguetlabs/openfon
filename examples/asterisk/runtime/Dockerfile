# Local validation image: no SIP listener, provider credentials, or paid services.
FROM debian:bookworm-slim
ARG ASTERISK_VERSION=22.11.0
ARG ASTERISK_SHA256=3bd5ee040509a3d3cd9b1ba9520c18e6ec0a7e7981ca68c457dcd36ba3c54d94
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential ca-certificates curl pkg-config libedit-dev libjansson-dev \
    libsqlite3-dev libssl-dev libxml2-dev uuid-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /usr/src
RUN curl --fail --location --retry 3 --max-time 180 -o asterisk.tar.gz \
      https://downloads.asterisk.org/pub/telephony/asterisk/asterisk-${ASTERISK_VERSION}.tar.gz \
 && echo "${ASTERISK_SHA256}  asterisk.tar.gz" | sha256sum --check \
 && tar xzf asterisk.tar.gz && cd asterisk-${ASTERISK_VERSION} \
 && ./configure --without-pjproject --without-dahdi --without-pri \
 && make menuselect.makeopts \
 && menuselect/menuselect --disable BUILD_NATIVE menuselect.makeopts \
 && make -j4 && make install \
 && rm -rf /usr/src/asterisk* /var/lib/asterisk/sounds/*
CMD ["asterisk", "-f", "-vvv"]
