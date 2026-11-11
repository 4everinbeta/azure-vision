targetScope = 'subscription'

@description('Region for the resource group and all resources.')
param location string = deployment().location

@description('Base name used for resources.')
param name string = 'azure-vision'

@description('Tag of the azure-vision-api and azure-vision-web images in the registry. Leave empty to deploy only the base infrastructure (registry, storage, identity, environment) before the images exist.')
param imageTag string = ''

@description('Entra tenant users sign in to (device code). Accounts from other tenants are rejected.')
param tenantId string = tenant().tenantId

@description('How long (ms) a stored inventory snapshot is served before re-querying Resource Graph.')
param cacheTtlMs int = 86400000

@description('How long (ms) per-subscription cost data is kept before Cost Management is queried again.')
param costCacheTtlMs int = 86400000

@description('Idle time (ms) after which a browser sign-in session expires.')
param sessionIdleMs int = 28800000

var rgName = 'rg-${name}'

resource rg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: rgName
  location: location
}

// No subscription role assignments: every user sees only what their own Azure RBAC allows.
module resources 'resources.bicep' = {
  name: '${name}-resources'
  scope: rg
  params: {
    location: location
    name: name
    imageTag: imageTag
    tenantId: tenantId
    cacheTtlMs: cacheTtlMs
    costCacheTtlMs: costCacheTtlMs
    sessionIdleMs: sessionIdleMs
  }
}

output resourceGroup string = rgName
output acrName string = resources.outputs.acrName
output acrLoginServer string = resources.outputs.acrLoginServer
output url string = resources.outputs.url
output kibanaApp string = resources.outputs.kibanaApp
output environmentName string = resources.outputs.environmentName
output storageAccountName string = resources.outputs.storageAccountName
output tableEndpoint string = resources.outputs.tableEndpoint
output managedIdentityClientId string = resources.outputs.managedIdentityClientId
