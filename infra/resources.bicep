targetScope = 'resourceGroup'

param location string
param name string
param imageTag string
param tenantId string
param cacheTtlMs int
param costCacheTtlMs int
param sessionIdleMs int

var suffix = uniqueString(resourceGroup().id)
var deployApps = !empty(imageTag)
var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
var tableContributorRoleId = '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'
var tableName = 'inventory'
var elasticImage = 'docker.elastic.co/elasticsearch/elasticsearch-wolfi:8.19.25@sha256:5d603518d4d6b9b2c6a5354e3580d9f3040e719f506b921fcce8564d229f9223'
var kibanaImage = 'docker.elastic.co/kibana/kibana-wolfi:8.19.25@sha256:1e092dfb5791bafe351250ba96896eba4ba3a409d7b0b2467fe4d6d5911507c0'

// One user-assigned identity for the app containers: pulls images and reads/writes the cache table.
// It has no access to subscriptions: Azure data is always read with the signed-in user's own token.
resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-${name}'
  location: location
}

resource logs 'Microsoft.OperationalInsights/workspaces@2022-10-01' = {
  name: 'log-${name}'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: take('acr${replace(name, '-', '')}${suffix}', 50)
  location: location
  sku: { name: 'Basic' }
  properties: { adminUserEnabled: false }
}

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: acr
  name: guid(acr.id, identity.id, acrPullRoleId)
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
  }
}

resource networkSecurityGroup 'Microsoft.Network/networkSecurityGroups@2024-05-01' = {
  name: 'nsg-${name}'
  location: location
  properties: {
    securityRules: [
      {
        name: 'AllowPublicHttps'
        properties: {
          priority: 100
          access: 'Allow'
          direction: 'Inbound'
          protocol: 'Tcp'
          sourceAddressPrefix: 'Internet'
          sourcePortRange: '*'
          destinationAddressPrefix: '10.42.0.0/23'
          destinationPortRanges: ['443', '31443']
        }
      }
    ]
  }
}

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: 'vnet-${name}'
  location: location
  properties: {
    addressSpace: { addressPrefixes: ['10.42.0.0/16'] }
    subnets: [
      {
        name: 'infrastructure'
        properties: {
          addressPrefix: '10.42.0.0/23'
          networkSecurityGroup: { id: networkSecurityGroup.id }
          delegations: [
            {
              name: 'container-apps'
              properties: { serviceName: 'Microsoft.App/environments' }
            }
          ]
        }
      }
      {
        name: 'private-endpoints'
        properties: {
          addressPrefix: '10.42.2.0/27'
          networkSecurityGroup: { id: networkSecurityGroup.id }
          privateEndpointNetworkPolicies: 'Disabled'
        }
      }
    ]
  }
}

// Cache persistence: private Table Storage, authenticated with the app identity and keyed per user.
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: take('stp${replace(name, '-', '')}${suffix}', 24)
  location: location
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    allowSharedKeyAccess: false
    allowBlobPublicAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    publicNetworkAccess: 'Disabled'
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'None'
      ipRules: []
      virtualNetworkRules: []
    }
    encryption: {
      keySource: 'Microsoft.Storage'
      requireInfrastructureEncryption: true
      services: {
        blob: { enabled: true, keyType: 'Account' }
        table: { enabled: true, keyType: 'Account' }
      }
    }
  }
}

// This does not back up tables; it protects blobs if any are added to the account.
resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    deleteRetentionPolicy: { enabled: true, days: 7 }
    containerDeleteRetentionPolicy: { enabled: true, days: 7 }
  }
}

resource tableService 'Microsoft.Storage/storageAccounts/tableServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource table 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: tableName
}

resource tableDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'table-audit'
  scope: tableService
  properties: {
    workspaceId: logs.id
    logAnalyticsDestinationType: 'Dedicated'
    logs: [
      { category: 'StorageRead', enabled: true }
      { category: 'StorageWrite', enabled: true }
      { category: 'StorageDelete', enabled: true }
    ]
  }
}

resource tableDnsZone 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: 'privatelink.table.${environment().suffixes.storage}'
  location: 'global'
}

resource tableDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: tableDnsZone
  name: 'container-apps'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: { id: vnet.id }
  }
}

resource tablePrivateEndpoint 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: 'pe-${name}-table'
  location: location
  properties: {
    subnet: { id: '${vnet.id}/subnets/private-endpoints' }
    privateLinkServiceConnections: [
      {
        name: 'table'
        properties: {
          privateLinkServiceId: storage.id
          groupIds: ['table']
        }
      }
    ]
  }
}

resource tablePrivateDnsZoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {
  parent: tablePrivateEndpoint
  name: 'table'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'table'
        properties: { privateDnsZoneId: tableDnsZone.id }
      }
    ]
  }
}

resource tableAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storage
  name: guid(storage.id, identity.id, tableContributorRoleId)
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', tableContributorRoleId)
  }
}

resource env 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'cae-${name}'
  location: location
  properties: {
    vnetConfiguration: {
      infrastructureSubnetId: '${vnet.id}/subnets/infrastructure'
      internal: false
    }
    workloadProfiles: [
      { name: 'Consumption', workloadProfileType: 'Consumption' }
    ]
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
  }
}

// Apps in the same environment reach each other by app name over plain HTTP (port 80 -> targetPort).
func internalIngress(port int) object => {
  external: false
  targetPort: port
  allowInsecure: true
  transport: 'http'
}

var apiEnv = [
  { name: 'SOURCE', value: 'local' }
  { name: 'AZURE_TENANT_ID', value: tenantId }
  { name: 'STORE', value: 'table' }
  { name: 'STORAGE_TABLE_ENDPOINT', value: storage.properties.primaryEndpoints.table }
  { name: 'STORAGE_TABLE_NAME', value: tableName }
  { name: 'MANAGED_IDENTITY_CLIENT_ID', value: identity.properties.clientId }
  { name: 'CACHE_TTL_MS', value: string(cacheTtlMs) }
  { name: 'COST_CACHE_TTL_MS', value: string(costCacheTtlMs) }
  { name: 'SESSION_IDLE_MS', value: string(sessionIdleMs) }
  { name: 'CLIENT_IP_HEADER', value: 'x-av-client-ip' }
  { name: 'ELASTICSEARCH_URL', value: 'http://elasticsearch' }
]

var apis = [
  // Holds the device-code sessions in memory: a single replica, so every request reaches the same sessions.
  { name: 'inventory-api', service: 'inventory', maxReplicas: 1, env: [] }
  // Runs the throttled per-subscription cost collection in-process: a single replica.
  { name: 'cost-api', service: 'cost', maxReplicas: 1, env: [{ name: 'INVENTORY_URL', value: 'http://inventory-api' }] }
  { name: 'layout-api', service: 'layout', maxReplicas: 2, env: [] }
]

resource apiApps 'Microsoft.App/containerApps@2024-03-01' = [
  for api in apis: if (deployApps) {
    name: api.name
    location: location
    identity: {
      type: 'UserAssigned'
      userAssignedIdentities: { '${identity.id}': {} }
    }
    properties: {
      managedEnvironmentId: env.id
      workloadProfileName: 'Consumption'
      configuration: {
        activeRevisionsMode: 'Single'
        ingress: internalIngress(3001)
        registries: [{ server: acr.properties.loginServer, identity: identity.id }]
      }
      template: {
        containers: [
          {
            name: api.name
            image: '${acr.properties.loginServer}/azure-vision-api:${imageTag}'
            resources: { cpu: json('0.5'), memory: '1Gi' }
            env: concat(apiEnv, [{ name: 'SERVICE', value: api.service }], api.env)
            probes: [
              {
                type: 'Startup'
                httpGet: { path: '/api/health', port: 3001 }
                periodSeconds: 3
                failureThreshold: 10
                initialDelaySeconds: 3
              }
              {
                type: 'Liveness'
                httpGet: { path: '/api/health', port: 3001 }
                periodSeconds: 30
              }
            ]
          }
        ]
        // Scale to zero when idle: users sign in again afterwards (tokens are kept in memory only).
        scale: { minReplicas: 0, maxReplicas: api.maxReplicas }
      }
    }
    dependsOn: [acrPull, tableAccess, table, tableDnsLink, tablePrivateDnsZoneGroup]
  }
]

resource web 'Microsoft.App/containerApps@2024-03-01' = if (deployApps) {
  name: 'web'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identity.id}': {} }
  }
  properties: {
    managedEnvironmentId: env.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 8080
        allowInsecure: false
        transport: 'auto'
      }
      registries: [{ server: acr.properties.loginServer, identity: identity.id }]
    }
    template: {
      containers: [
        {
          name: 'web'
          image: '${acr.properties.loginServer}/azure-vision-web:${imageTag}'
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          env: [
            { name: 'INVENTORY_UPSTREAM', value: 'http://inventory-api' }
            { name: 'COST_UPSTREAM', value: 'http://cost-api' }
            { name: 'LAYOUT_UPSTREAM', value: 'http://layout-api' }
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: { path: '/api/health', port: 8080 }
              periodSeconds: 30
            }
          ]
        }
      ]
      scale: { minReplicas: 0, maxReplicas: 2 }
    }
  }
  // nginx resolves its upstreams at start-up, so they must exist first.
  dependsOn: [apiApps]
}

// Search index: derived data (rebuilt as users load inventory/costs), so it uses the container's ephemeral disk.
// Security is off, which is only acceptable because ingress is internal to the environment. Never make it external.
resource elasticsearch 'Microsoft.App/containerApps@2024-03-01' = if (deployApps) {
  name: 'elasticsearch'
  location: location
  properties: {
    managedEnvironmentId: env.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: internalIngress(9200)
    }
    template: {
      containers: [
        {
          name: 'elasticsearch'
          image: elasticImage
          resources: { cpu: json('0.75'), memory: '1.5Gi' }
          // ES_SETTING_*: dots become "_", underscores become "__".
          env: [
            { name: 'ES_SETTING_DISCOVERY_TYPE', value: 'single-node' }
            { name: 'ES_SETTING_XPACK_SECURITY_ENABLED', value: 'false' }
            { name: 'ES_SETTING_NODE_STORE_ALLOW__MMAP', value: 'false' } // vm.max_map_count cannot be raised in Container Apps
            { name: 'ES_SETTING_CLUSTER_ROUTING_ALLOCATION_DISK_THRESHOLD__ENABLED', value: 'false' }
            { name: 'ES_JAVA_OPTS', value: '-Xms512m -Xmx512m' }
          ]
          probes: [
            {
              type: 'Startup'
              httpGet: { path: '/_cluster/health?local=true', port: 9200 }
              initialDelaySeconds: 20
              periodSeconds: 10
              failureThreshold: 10
            }
            {
              type: 'Readiness'
              httpGet: { path: '/_cluster/health?local=true', port: 9200 }
              periodSeconds: 15
            }
          ]
        }
      ]
      scale: { minReplicas: 1, maxReplicas: 1 } // kept warm: the index lives in the replica
    }
  }
}

// Admin UI for the search index. Internal only; infra/kibana.sh opens it temporarily to the caller's IP.
resource kibana 'Microsoft.App/containerApps@2024-03-01' = if (deployApps) {
  name: 'kibana'
  location: location
  properties: {
    managedEnvironmentId: env.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: internalIngress(5601)
    }
    template: {
      containers: [
        {
          name: 'kibana'
          image: kibanaImage
          resources: { cpu: json('0.75'), memory: '1.5Gi' }
          env: [
            { name: 'ELASTICSEARCH_HOSTS', value: 'http://elasticsearch:80' }
            { name: 'NODE_OPTIONS', value: '--max-old-space-size=1024' }
          ]
        }
      ]
      scale: { minReplicas: 0, maxReplicas: 1 }
    }
  }
  dependsOn: [elasticsearch]
}

output acrName string = acr.name
output acrLoginServer string = acr.properties.loginServer
output url string = deployApps ? 'https://${web!.properties.configuration.ingress.fqdn}' : ''
output kibanaApp string = 'kibana'
output environmentName string = env.name
output storageAccountName string = storage.name
output tableEndpoint string = storage.properties.primaryEndpoints.table
output managedIdentityClientId string = identity.properties.clientId
