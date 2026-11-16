// `test/common/udp.js`: whether the platform accepts `reusePort` on a UDP
// socket. Node probes with a real socket; so does this, and a rejection (as on
// Windows, where `reusePort` is `ENOTSUP`) is what the tests turn into a skip.

const __harnessUdpOptions: any = { type: "udp4", reusePort: true };

function __harnessUdpCheckSupportReusePort(): Promise<void> {
  return new Promise<void>(function (resolve: any, reject: any): void {
    const socket: any = __node_dgram.createSocket(__harnessUdpOptions);
    socket.on("error", function (err: any): void {
      reject(err);
    });
    socket.bind(0, function (): void {
      socket.close();
      resolve(undefined);
    });
  });
}

const __node_harness_udp: any = {
  options: __harnessUdpOptions,
  checkSupportReusePort: __harnessUdpCheckSupportReusePort,
};
