import * as redis from "redis";
import * as Websocket from "ws";
import { v4 } from "uuid";
import * as http from "http";

function noop() {}

const sync_payload = JSON.stringify({ type: "SYNC" });

type Config = {
  interval_ms?: number;
  websocket_config?: Websocket.ServerOptions;
  redis_config?: redis.ClientOpts;
  redis_pubsub_name?: string;
};

type WebsocketEnhanced = Websocket & {
  id: string;
  is_alive: boolean;
  room_id?: string;
};

class WebsocketHandler {
  pub: redis.RedisClient;
  sub: redis.RedisClient;
  wss: Websocket.Server;
  ROOM_MAP: Record<string, Websocket[]> = {};
  config: Config;
  constructor(config: Config = {}) {
    this.config = {
      ...{
        interval_ms: 30000,
        websocket_config: { port: 8080 },
        redis_config: {},
        redis_pubsub_name: "REDIS_PUBSUB",
      },
      ...config,
    };
    /** Initialize pub sub and wss */
    this.pub = redis.createClient(config.redis_config);
    this.sub = redis.createClient(config.redis_config);
    this.wss = new Websocket.Server(config.websocket_config);

    /** Subscribe to redis and handle connection */
    this.sub.on("message", this.handleRedisMessage);
    this.wss.on("connection", (ws, req) =>
      this.onConnection(ws as WebsocketEnhanced, req)
    );

    /** Handle heartbeat */
    setInterval(this.onHeartbeat, this.config.interval_ms);
  }

  initWS(ws: WebsocketEnhanced) {
    ws.is_alive = true;
    ws.id = v4();
  }

  join = (room_id: string, ws: WebsocketEnhanced) => {
    console.log("JOIN");
    ws.room_id = room_id;
    if (this.ROOM_MAP.hasOwnProperty(room_id)) {
      this.ROOM_MAP[room_id].push(ws);
    } else {
      this.ROOM_MAP[room_id] = [ws];
      this.onJoinNewRoom(room_id);
    }
  };

  pong = (ws: WebsocketEnhanced) => {
    ws.is_alive = true;
  };

  close = (ws: WebsocketEnhanced) => {
    this.leaveRoom(ws);
    ws.terminate();
  };

  leaveRoom = (ws: WebsocketEnhanced) => {
    let room_id = ws.room_id;
    if (room_id && this.ROOM_MAP[room_id]) {
      this.ROOM_MAP[room_id] = this.ROOM_MAP[room_id].filter(
        (client) => client !== ws
      );

      if (this.ROOM_MAP[room_id].length == 0) {
        delete this.ROOM_MAP[room_id];
        this.onLastLeaveRoom(room_id);
      }
    }
  };

  onJoinNewRoom = (room_id: string) => {
    console.log("JOIN NEW ROOM");
    this.sub.subscribe(this.pubSubChannelId(room_id));
  };

  onLastLeaveRoom = (room_id: string) => {
    console.log("LAST LEAVE ROOM");
    this.sub.unsubscribe(this.pubSubChannelId(room_id));
  };

  pubSubChannelId = (room_id: string) =>
    [this.config.redis_pubsub_name, room_id].join(":");

  isCorrectChannel(channel: string) {
    return channel == this.config.redis_pubsub_name;
  }

  socketsInRoom = (room_id: string): WebsocketEnhanced[] =>
    (this.ROOM_MAP[room_id] as WebsocketEnhanced[]) || [];

  onHeartbeat = () => {
    console.log("HEARTBEAT");
    this.wss.clients.forEach((ss) => {
      let ws = ss as WebsocketEnhanced;
      if (!ws.is_alive) {
        this.close(ws);
      }
      ws.is_alive = false;
      ws.ping(noop);
    });
  };

  onConnection = (ws: WebsocketEnhanced, req: http.IncomingMessage) => {
    /** Decode user id and generate socket id */
    let room_id = req.headers.decoded as string;

    this.initWS(ws);
    this.join(room_id, ws);

    ws.on("pong", () => this.pong(ws));
    ws.on("close", () => this.close(ws));
    ws.send(JSON.stringify({ type: "SYNC" }));
    ws.on("message", (msg) => this.onMessage(msg as string, ws));
  };

  onMessage = (msg: string, ws: WebsocketEnhanced) => {
    try {
      this.pub.publish(
        this.pubSubChannelId(ws.room_id),
        JSON.stringify({
          sender_socket_id: ws.id,
          payload: JSON.parse(msg as string),
        })
      );
    } catch {
      console.log("INVALID EVENT SENT FROM CLIENT");
    }
  };

  handleRedisMessage = (channel: string, data: string) => {
    const [pubsub_name, room_id] = channel.split(":");
    if (this.isCorrectChannel(pubsub_name)) {
      try {
        let {
          payload: { type },
          sender_socket_id,
        }: { payload: { type: string }; sender_socket_id: string } = JSON.parse(
          data
        );

        switch (type) {
          case "SYNC":
            this.socketsInRoom(room_id).forEach((ws) => {
              if (
                ws.id !== sender_socket_id &&
                ws.readyState == Websocket.OPEN
              ) {
                console.log("SEND SYNC");
                ws.send(sync_payload);
              }
            });
            return;
          default:
            return;
        }
      } catch {
        console.error("Parsing data error inside Redis sub");
      }
    }
  };
}

let config: Config = {
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

new WebsocketHandler(config);
