# k6 built with the xk6-sip-media extension, for the SIP and RTP scripts.
#
# The extension needs CGO (the Opus codec links libopus), so it cannot be built
# with the stock grafana/xk6 image. Building in golang:alpine makes the binary
# musl-linked, so it runs on the alpine-based grafana/k6 image.
ARG K6_VERSION=1.8.1
ARG XK6_SIP_MEDIA_VERSION=v1.2.1

FROM golang:1.27-alpine AS builder
ARG K6_VERSION
ARG XK6_SIP_MEDIA_VERSION
RUN apk add --no-cache gcc musl-dev pkgconfig opus-dev opusfile-dev git
RUN go install go.k6.io/xk6/cmd/xk6@v1.4.13
COPY patches/ /patches/
RUN git clone --depth 1 --branch "${XK6_SIP_MEDIA_VERSION}" \
        https://github.com/srthorat/xk6-sip-media /src/xk6-sip-media \
    && git -C /src/xk6-sip-media apply /patches/*.patch
WORKDIR /build
RUN K6_VERSION="v${K6_VERSION}" xk6 build --cgo \
    --with "github.com/srthorat/xk6-sip-media=/src/xk6-sip-media" \
    --output /build/k6

FROM grafana/k6:${K6_VERSION}-with-browser
USER root
RUN apk add --no-cache opus opusfile
COPY --from=builder /build/k6 /usr/bin/k6
USER 12345
