# @relay-harness/rlh-host-product-mode

English | [中文](README.zh.md)

Settings-backed Host owner of the shared `simple` / `developer` product mode. Fresh profiles inherit `simple`; an explicit stored value survives upgrades. Generated `productMode.get/set` Remotes let the shared Web client read and persist the same mode in browsers and Desktop.

## Model Experience

### No direct model request

#### What the model sees

Nothing. `ctx.productMode` controls browser and Desktop presentation only; its Remote never appends Session context.

#### Token effect

Zero tokens. Reading or persisting a product mode never assembles a model request.

#### KV Cache effect

None. Mode changes never alter model requests or cache prefixes.

## Known Limitations and Deferred Work

- Cross-tab changes are observed on reconnect/reload; a dedicated forwarded change event is deferred.
