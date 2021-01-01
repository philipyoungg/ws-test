import * as redis from "redis";
import * as Websocket from "ws";
import { v4 } from "uuid";
import * as http from "http";

function noop() {}

export type WebsocketHandlerConfig = {
  interval_ms?: number;
  websocket_config?: Websocket.ServerOptions;
  redis_config?: redis.ClientOpts;
  redis_pubsub_name?: string;
};

type PubsubPayload = {
  type: string;
  payload: string;
  sender_ws_id: string;
};

type WebsocketEnhanced = Websocket & {
  id: string;
  is_alive: boolean;
  room_id?: string;
};

/**
 * Currently only handle one room per user
 */
class WebsocketHandler {
  private pub: redis.RedisClient;
  private sub: redis.RedisClient;
  private wss: Websocket.Server;
  private ROOM_MAP: Record<string, Websocket[]> = {};
  private config: WebsocketHandlerConfig;
  constructor(__RAW_CONFIG__: WebsocketHandlerConfig = {}) {
    this.config = {
      ...{
        interval_ms: 30000,
        websocket_config: { port: 8080 },
        redis_config: {},
        redis_pubsub_name: "REDIS_PUBSUB",
      },
      ...__RAW_CONFIG__,
    };
    /** Initialize pub sub and wss */
    this.pub = redis.createClient(this.config.redis_config);
    this.sub = this.pub.duplicate();
    this.wss = new Websocket.Server(this.config.websocket_config);

    /** Subscribe to redis and handle connection */
    this.sub.on("message", this.onRedisMessage);
    this.wss.on("connection", (ws, req) =>
      this.setupAndOnConnection(ws as WebsocketEnhanced, req)
    );

    /** Handle heartbeat */
    setInterval(this.onHeartbeat, this.config.interval_ms);
  }

  onConnection = (ws: WebsocketEnhanced, decoded: unknown) => {
    console.log("onConnection not handled");
  };

  onMessage = (msg: string, ws: WebsocketEnhanced) => {
    console.log("onMessage not handled");
  };

  joinRoom = (room_id: string, ws: WebsocketEnhanced) => {
    console.log("JOIN");
    ws.room_id = room_id;
    if (this.ROOM_MAP.hasOwnProperty(room_id)) {
      this.ROOM_MAP[room_id].push(ws);
    } else {
      this.ROOM_MAP[room_id] = [ws];
      this.onJoinNewRoom(room_id);
    }
  };

  broadcastEmit = (payload: string, room_id: string, ws: WebsocketEnhanced) => {
    try {
      let pubsubPayload: PubsubPayload = {
        sender_ws_id: ws.id,
        type: "BROADCAST_EMIT",
        payload,
      };
      this.pub.publish(
        this.pubSubChannelId(ws.room_id),
        JSON.stringify(pubsubPayload)
      );
    } catch (err) {
      console.error("Parsing data error inside broadcast emit", err);
    }
  };

  /** Internal APIs */

  private setupAndOnConnection = (
    ws: WebsocketEnhanced,
    req: http.IncomingMessage
  ) => {
    /** Decode user id and generate socket id */
    let decoded = req.headers.decoded;

    this.initWS(ws);
    ws.on("pong", () => this.pong(ws));
    ws.on("close", () => this.close(ws));

    this.onConnection(ws, decoded);
  };

  private initWS(ws: WebsocketEnhanced) {
    ws.is_alive = true;
    ws.id = v4();
  }

  private pong = (ws: WebsocketEnhanced) => {
    ws.is_alive = true;
  };

  private close = (ws: WebsocketEnhanced) => {
    this.leaveRoom(ws);
    ws.terminate();
  };

  private onHeartbeat = () => {
    console.log("HEARTBEAT");
    let clients = this.wss.clients as Set<WebsocketEnhanced>;
    clients.forEach((ss) => {
      let ws = ss as WebsocketEnhanced;
      if (!ws.is_alive) {
        this.close(ws);
      }
      ws.is_alive = false;
      ws.ping(noop);
    });
  };

  private leaveRoom = (ws: WebsocketEnhanced) => {
    let room_id = ws.room_id;

    if (!room_id || !this.ROOM_MAP[room_id]) {
      return;
    }

    this.ROOM_MAP[room_id] = this.ROOM_MAP[room_id].filter(
      (client) => client !== ws
    );

    if (this.ROOM_MAP[room_id].length == 0) {
      delete this.ROOM_MAP[room_id];
      this.onLastLeaveRoom(room_id);
    }
  };

  private onJoinNewRoom = (room_id: string) => {
    console.log("JOIN NEW ROOM");
    this.sub.subscribe(this.pubSubChannelId(room_id));
  };

  private onLastLeaveRoom = (room_id: string) => {
    console.log("LAST LEAVE ROOM");
    this.sub.unsubscribe(this.pubSubChannelId(room_id));
  };

  private pubSubChannelId = (room_id: string) =>
    [this.config.redis_pubsub_name, room_id].join(":");

  private isCorrectChannel(channel: string) {
    return channel == this.config.redis_pubsub_name;
  }

  private socketsInRoom = (room_id: string): WebsocketEnhanced[] =>
    (this.ROOM_MAP[room_id] as WebsocketEnhanced[]) || [];

  private onRedisMessage = (channel: string, data: string) => {
    const [pubsub_name, room_id] = channel.split(":");
    if (this.isCorrectChannel(pubsub_name)) {
      try {
        let { type, sender_ws_id, payload } = JSON.parse(data) as PubsubPayload;

        switch (type) {
          case "BROADCAST_EMIT":
            this.socketsInRoom(room_id).forEach((ws) => {
              if (ws.id !== sender_ws_id && ws.readyState == Websocket.OPEN) {
                console.log("BROADCAST EMIT ON ", payload);
                ws.send(payload);
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

export default WebsocketHandler;
