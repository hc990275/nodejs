FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Asia/Shanghai

WORKDIR /app

RUN apt-get update -y && \
    apt-get install -y --no-install-recommends \
    nodejs \
    npm \
    curl \
    tar \
    ca-certificates \
    openssl \
    iptables \
    procps \
    tzdata && \
    ln -fs /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && \
    dpkg-reconfigure --frontend noninteractive tzdata && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

COPY . /app

RUN chmod +x /app/start.sh /app/install_service.sh 2>/dev/null || true

EXPOSE 10809 10800 10801 10802 10803 10804 10805 10806 10900-10909/udp

CMD ["/bin/sh", "/app/start.sh"]
