FROM node:12
WORKDIR app
copy package.json ./app 
cmd ["cd", "./app"]
RUN npm install
COPY . .
expose 80
env PORT=80
cmd ["node", "example.js"]
