const WebSocket = require("ws");

let websockets = [];
let ws;
const connect = (i) => {
  ws = new WebSocket(
    "ws://localhost:8000",
    i % 3 == 0 ? "s3" : i % 2 == 0 ? "s2" : "s1"
  );
  ws.onmessage = (d) => console.log(d.data);
  ws.onclose = (ev) => {
    console.log(ev);
    setTimeout(() => connect(i), Math.random() * 10000);
  };
  ws.onerror = (ev) => {
    console.log(ev);
    setTimeout(() => connect(i), Math.random() * 10000);
  };
  websockets.push(ws);
};

for (var i = 0; i <= 10000; i++) {
  setTimeout(() => {
    connect(i);
  }, 50 * i);
}
