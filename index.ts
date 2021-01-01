import WebsocketPubSub, { WebsocketHandlerConfig } from "./WebsocketPubSub";

const sync_payload = JSON.stringify({ type: "SYNC" });

let config: WebsocketHandlerConfig = {
  interval_ms: 3000,
  websocket_config: {
    port: Number(process.env.PORT) || 8080,
    verifyClient: (info, done) => {
      let token = info.req.headers["sec-websocket-protocol"];
      if (token) {
        try {
          info.req.headers.decoded = token;
          return done(true);
        } catch {
          return done(false, 401, "Unauthorized");
        }
      }

      return done(false, 401, "Unauthorized");
    },
  },
  redis_pubsub_name: "SESSION_PUBSUB",
};

let handler = new WebsocketPubSub(config);

handler.onConnection = (ws, decoded) => {
  let user_id = decoded as string;
  handler.joinRoom(user_id, ws);
  ws.send(sync_payload);

  ws.on("message", (msg) => {
    try {
      let parsed: { type: string } = JSON.parse(msg as string);
      if (parsed.type == "SYNC") {
        handler.broadcastEmit(sync_payload, ws.room_id, ws);
      }
    } catch {
      console.log("INVALID EVENT SENT FROM CLIENT");
    }
  });
};
