new Proxy(
  {},
  {
    get(target, prop) {
      console.log(prop);
    },
  }
);
}
