import { InternalModuleDeclaration, MedusaModule } from "@medusajs/modules-sdk"
import {
  ExternalModuleDeclaration,
  ILinkModule,
  LinkModuleDefinition,
  LoaderOptions,
  MODULE_RESOURCE_TYPE,
  MODULE_SCOPE,
  ModuleExports,
  ModuleJoinerConfig,
  ModuleServiceInitializeCustomDataLayerOptions,
  ModuleServiceInitializeOptions,
} from "@medusajs/types"
import {
  ContainerRegistrationKeys,
  lowerCaseFirst,
  simpleHash,
} from "@medusajs/utils"
import * as linkDefinitions from "../definitions"
import { getMigration } from "../migration"
import { InitializeModuleInjectableDependencies } from "../types"
import { composeLinkName } from "../utils"
import { getLinkModuleDefinition } from "./module-definition"

export const initialize = async (
  options?:
    | ModuleServiceInitializeOptions
    | ModuleServiceInitializeCustomDataLayerOptions
    | ExternalModuleDeclaration
    | InternalModuleDeclaration,
  modulesDefinition?: ModuleJoinerConfig[],
  injectedDependencies?: InitializeModuleInjectableDependencies
): Promise<{ [link: string]: ILinkModule }> => {
  const allLinks = {}
  const modulesLoadedKeys = MedusaModule.getLoadedModules().map(
    (mod) => Object.keys(mod)[0]
  )

  const allLinksToLoad = Object.values(linkDefinitions).concat(
    modulesDefinition ?? []
  )

  for (const linkDefinition of allLinksToLoad) {
    const definition = JSON.parse(JSON.stringify(linkDefinition))

    const [primary, foreign] = definition.relationships ?? []

    if (definition.relationships?.length !== 2 && !definition.isReadOnlyLink) {
      throw new Error(
        `Link module ${definition.serviceName} can only link 2 modules.`
      )
    } else if (
      foreign?.foreignKey?.split(",").length > 1 &&
      !definition.isReadOnlyLink
    ) {
      throw new Error(`Foreign key cannot be a composed key.`)
    }

    const serviceKey = !definition.isReadOnlyLink
      ? lowerCaseFirst(
          definition.serviceName ??
            composeLinkName(
              primary.serviceName,
              primary.foreignKey,
              foreign.serviceName,
              foreign.foreignKey
            )
        )
      : simpleHash(JSON.stringify(definition.extends))

    if (modulesLoadedKeys.includes(serviceKey)) {
      continue
    } else if (serviceKey in allLinks) {
      throw new Error(`Link module ${serviceKey} already defined.`)
    }

    if (definition.isReadOnlyLink) {
      const extended: any[] = []
      for (const extension of definition.extends ?? []) {
        if (
          modulesLoadedKeys.includes(extension.serviceName) &&
          modulesLoadedKeys.includes(extension.relationship.serviceName)
        ) {
          extended.push(extension)
        }
      }

      definition.extends = extended
      if (extended.length === 0) {
        continue
      }
    } else if (
      !modulesLoadedKeys.includes(primary.serviceName) ||
      !modulesLoadedKeys.includes(foreign.serviceName)
    ) {
      continue
    }

    const moduleDefinition = getLinkModuleDefinition(
      definition,
      primary,
      foreign
    ) as ModuleExports

    const linkModuleDefinition: LinkModuleDefinition = {
      key: serviceKey,
      registrationName: serviceKey,
      label: serviceKey,
      defaultModuleDeclaration: {
        scope: MODULE_SCOPE.INTERNAL,
        resources: injectedDependencies?.[
          ContainerRegistrationKeys.PG_CONNECTION
        ]
          ? MODULE_RESOURCE_TYPE.SHARED
          : MODULE_RESOURCE_TYPE.ISOLATED,
      },
    }

    const loaded = await MedusaModule.bootstrapLink(
      linkModuleDefinition,
      options as InternalModuleDeclaration,
      moduleDefinition,
      injectedDependencies
    )

    allLinks[serviceKey as string] = Object.values(loaded)[0]
  }

  return allLinks
}

export async function runMigrations(
  {
    options,
    logger,
  }: Omit<LoaderOptions<ModuleServiceInitializeOptions>, "container">,
  modulesDefinition?: ModuleJoinerConfig[]
) {
  const modulesLoadedKeys = MedusaModule.getLoadedModules().map(
    (mod) => Object.keys(mod)[0]
  )

  const allLinksToLoad = Object.values(linkDefinitions).concat(
    modulesDefinition ?? []
  )

  const allLinks = new Set<string>()
  for (const definition of allLinksToLoad) {
    if (definition.isReadOnlyLink) {
      continue
    }

    if (definition.relationships?.length !== 2) {
      throw new Error(
        `Link module ${definition.serviceName} must have 2 relationships.`
      )
    }

    const [primary, foreign] = definition.relationships ?? []
    const serviceKey = lowerCaseFirst(
      definition.serviceName ??
        composeLinkName(
          primary.serviceName,
          primary.foreignKey,
          foreign.serviceName,
          foreign.foreignKey
        )
    )

    if (modulesLoadedKeys.includes(serviceKey)) {
      continue
    } else if (allLinks.has(serviceKey)) {
      throw new Error(`Link module ${serviceKey} already exists.`)
    }

    allLinks.add(serviceKey)

    if (
      !modulesLoadedKeys.includes(primary.serviceName) ||
      !modulesLoadedKeys.includes(foreign.serviceName)
    ) {
      continue
    }

    const migrate = getMigration(definition, serviceKey, primary, foreign)
    await migrate({ options, logger })
  }
}
