package service

func ResolveTenantShardRoute(tenant string) string {
    return "shard:" + tenant
}
