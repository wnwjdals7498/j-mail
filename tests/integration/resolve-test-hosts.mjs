import { readFileSync } from "node:fs";
import { lookup } from "node:dns";
import { Agent, setGlobalDispatcher } from "undici";
if (process.env.JML_TEST_RUNTIME !== "isolated-cloud")
  throw new Error("Isolated test resolver required.");
setGlobalDispatcher(
  new Agent({
    connect: {
      ca: [
        readFileSync(process.env.JAUTH_TLS_CERTIFICATE),
        readFileSync(process.env.JML_TLS_CERTIFICATE),
      ],
      lookup: (host, options, callback) => {
        if (
          ["auth.jgw.test", "jauth.jgw.test", "mail.jgw.test"].includes(host)
        ) {
          if (options.all)
            callback(null, [{ address: "127.0.0.1", family: 4 }]);
          else callback(null, "127.0.0.1", 4);
        } else lookup(host, options, callback);
      },
    },
  }),
);
