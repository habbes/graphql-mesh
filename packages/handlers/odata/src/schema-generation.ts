import { EventEmitter } from 'events';
import {
  isAbstractType,
  GraphQLObjectType,
  GraphQLSchema,
  specifiedDirectives,
} from 'graphql';
import {
  SchemaComposer,
  ObjectTypeComposer,
  InterfaceTypeComposer,
  ObjectTypeComposerFieldConfigDefinition,
  ObjectTypeComposerArgumentConfigMapDefinition,
  EnumTypeComposerValueConfigDefinition,
  InputTypeComposer,
} from 'graphql-compose';
import {
  GraphQLBigInt,
  GraphQLGUID,
  GraphQLDateTime,
  GraphQLJSON,
  GraphQLDate,
  GraphQLByte,
  GraphQLISO8601Duration,
} from 'graphql-scalars';
import { jsonFlatStringify } from "@graphql-mesh/utils";
import { YamlConfig } from '@graphql-mesh/types';
import { parseResolveInfo, ResolveTree, simplifyParsedResolveInfoFragmentWithType } from 'graphql-parse-resolve-info';
import urljoin from 'url-join';
import { pascalCase } from 'pascal-case';
import { Request } from 'cross-fetch';
import { SCALARS } from './scalars';
import { queryOptionsFields } from './query-options';
import { EntityTypeExtensions } from './schema-util';
import { addIdentifierToUrl, getUrlString } from './util';
import { handleResponseText, HeadersFactory } from './request-processing'

type GenerateSchemaArgs = {
  metadataJson: any,
  commonArgs: Record<string, { type: string }>,
  contextVariables: string[],
  contextDataloaderName: string | symbol,
  headersFactory: HeadersFactory,
  config: YamlConfig.ODataHandler,
  env: Record<string, string>,
  baseUrl: string,
  eventEmitterSet: Set<EventEmitter>
}

export function generateGraphQLSchema({
  metadataJson,
  commonArgs,
  contextVariables,
  contextDataloaderName,
  headersFactory,
  config,
  env,
  baseUrl,
  eventEmitterSet
}: GenerateSchemaArgs): GraphQLSchema {
  const schemaComposer = initSchemaComposer();

  const aliasNamespaceMap = new Map<string, string>();

  const schemas = metadataJson.Edmx[0].DataServices[0].Schema;
  const multipleSchemas = schemas.length > 1;
  const namespaces = new Set<string>();

  function getNamespaceFromTypeRef(typeRef: string) {
    let namespace = '';
    namespaces?.forEach(el => {
      if (
        typeRef.startsWith(el) &&
        el.length > namespace.length && // It can be deeper namespace
        !typeRef.replace(el + '.', '').includes('.') // Typename cannot have `.`
      ) {
        namespace = el;
      }
    });
    return namespace;
  }

  function getTypeNameFromRef({
    typeRef,
    isInput,
    isRequired,
  }: {
    typeRef: string;
    isInput: boolean;
    isRequired: boolean;
  }) {
    const typeRefArr = typeRef.split('Collection(');
    const arrayDepth = typeRefArr.length;
    let actualTypeRef = typeRefArr.join('').split(')').join('');
    const typeNamespace = getNamespaceFromTypeRef(actualTypeRef);
    if (aliasNamespaceMap.has(typeNamespace)) {
      const alias = aliasNamespaceMap.get(typeNamespace);
      actualTypeRef = actualTypeRef.replace(typeNamespace, alias);
    }
    const actualTypeRefArr = actualTypeRef.split('.');
    const typeName = multipleSchemas
      ? pascalCase(actualTypeRefArr.join('_'))
      : actualTypeRefArr[actualTypeRefArr.length - 1];
    let realTypeName = typeName;
    if (SCALARS.has(actualTypeRef)) {
      realTypeName = SCALARS.get(actualTypeRef);
    } else if (schemaComposer.isEnumType(typeName)) {
      realTypeName = typeName;
    } else if (isInput) {
      realTypeName += 'Input';
    }
    const fakeEmptyArr = new Array(arrayDepth);
    realTypeName = fakeEmptyArr.join('[') + realTypeName + fakeEmptyArr.join(']');
    if (isRequired) {
      realTypeName += '!';
    }
    return realTypeName;
  }

  schemaComposer.createEnumTC({
    name: 'InlineCount',
    values: {
      allpages: {
        value: 'allpages',
        description:
          'The OData MUST include a count of the number of entities in the collection identified by the URI (after applying any $filter System Query Options present on the URI)',
      },
      none: {
        value: 'none',
        description:
          'The OData service MUST NOT include a count in the response. This is equivalence to a URI that does not include a $inlinecount query string parameter.',
      },
    },
  });

  schemaComposer.createInputTC({
    name: 'QueryOptions',
    fields: queryOptionsFields,
  });

  function getTCByTypeNames(...typeNames: string[]) {
    for (const typeName of typeNames) {
      try {
        return schemaComposer.getAnyTC(typeName);
      } catch {}
    }
    return null;
  }

  function rebuildOpenInputObjects(input: any) {
    if (typeof input === 'object') {
      if ('rest' in input) {
        Object.assign(input, input.rest);
        delete input.rest;
      }
      for (const fieldName in input) {
        rebuildOpenInputObjects(input[fieldName]);
      }
    }
  }

  function buildName({ schemaNamespace, name }: { schemaNamespace: string; name: string }) {
    const alias = aliasNamespaceMap.get(schemaNamespace) || schemaNamespace;
    const ref = alias + '.' + name;
    return multipleSchemas ? pascalCase(ref.split('.').join('_')) : name;
  }

  schemas?.forEach((schemaObj: any) => {
    const schemaNamespace = schemaObj.attributes.Namespace;
    namespaces.add(schemaNamespace);
    const schemaAlias = schemaObj.attributes.Alias;
    if (schemaAlias) {
      aliasNamespaceMap.set(schemaNamespace, schemaAlias);
    }
  });

  // start schemas.forEach loop
  schemas?.forEach((schemaObj: any) => {
    const schemaNamespace = schemaObj.attributes.Namespace;

    schemaObj.EnumType?.forEach((enumObj: any) => {
      const values: Record<string, EnumTypeComposerValueConfigDefinition> = {};
      enumObj.Member?.forEach((memberObj: any) => {
        const key = memberObj.attributes.Name;
        // This doesn't work.
        // const value = memberElement.getAttribute('Value')!;
        values[key] = {
          value: key,
          extensions: { memberObj },
        };
      });
      const enumTypeName = buildName({ schemaNamespace, name: enumObj.attributes.Name });
      schemaComposer.createEnumTC({
        name: enumTypeName,
        values,
        extensions: { enumObj },
      });
    });

    const allTypes = (schemaObj.EntityType || []).concat(schemaObj.ComplexType || []);
    const typesWithBaseType = allTypes.filter((typeObj: any) => typeObj.attributes.BaseType);

    allTypes?.forEach((typeObj: any) => {
      const entityTypeName = buildName({ schemaNamespace, name: typeObj.attributes.Name });
      const isOpenType = typeObj.attributes.OpenType === 'true';
      const isAbstract = typeObj.attributes.Abstract === 'true';
      const eventEmitter = new EventEmitter();
      eventEmitter.setMaxListeners(Infinity);
      eventEmitterSet.add(eventEmitter);
      const extensions: EntityTypeExtensions = {
        entityInfo: {
          actualFields: [],
          navigationFields: [],
          isOpenType,
        },
        typeObj,
        eventEmitter,
      };
      const inputType = schemaComposer.createInputTC({
        name: entityTypeName + 'Input',
        fields: {},
        extensions: () => extensions,
      });
      let abstractType: InterfaceTypeComposer;
      if (
        typesWithBaseType.some((typeObj: any) => typeObj.attributes.BaseType.includes(`.${entityTypeName}`)) ||
        isAbstract
      ) {
        abstractType = schemaComposer.createInterfaceTC({
          name: isAbstract ? entityTypeName : `I${entityTypeName}`,
          extensions,
          resolveType: (root: any) => {
            const typeRef = root['@odata.type']?.replace('#', '');
            if (typeRef) {
              const typeName = getTypeNameFromRef({
                typeRef: root['@odata.type'].replace('#', ''),
                isInput: false,
                isRequired: false,
              });
              return typeName;
            }
            return isAbstract ? `T${entityTypeName}` : entityTypeName;
          },
        });
      }
      const outputType = schemaComposer.createObjectTC({
        name: isAbstract ? `T${entityTypeName}` : entityTypeName,
        extensions,
        interfaces: abstractType ? [abstractType] : [],
      });

      abstractType?.setInputTypeComposer(inputType);
      outputType.setInputTypeComposer(inputType);

      const propertyRefObj = typeObj.Key && typeObj.Key[0].PropertyRef[0];
      if (propertyRefObj) {
        extensions.entityInfo.identifierFieldName = propertyRefObj.attributes.Name;
      }

      typeObj.Property?.forEach((propertyObj: any) => {
        const propertyName = propertyObj.attributes.Name;
        extensions.entityInfo.actualFields.push(propertyName);
        const propertyTypeRef = propertyObj.attributes.Type;
        if (propertyName === extensions.entityInfo.identifierFieldName) {
          extensions.entityInfo.identifierFieldTypeRef = propertyTypeRef;
        }
        const isRequired = propertyObj.attributes.Nullable === 'false';
        inputType.addFields({
          [propertyName]: {
            type: getTypeNameFromRef({
              typeRef: propertyTypeRef,
              isInput: true,
              isRequired,
            }),
            extensions: { propertyObj },
          },
        });
        const field: ObjectTypeComposerFieldConfigDefinition<any, unknown> = {
          type: getTypeNameFromRef({
            typeRef: propertyTypeRef,
            isInput: false,
            isRequired,
          }),
          extensions: { propertyObj },
        };
        abstractType?.addFields({
          [propertyName]: field,
        });
        outputType.addFields({
          [propertyName]: field,
        });
      });
      typeObj.NavigationProperty?.forEach((navigationPropertyObj: any) => {
        const navigationPropertyName = navigationPropertyObj.attributes.Name;
        extensions.entityInfo.navigationFields.push(navigationPropertyName);
        const navigationPropertyTypeRef = navigationPropertyObj.attributes.Type;
        const isRequired = navigationPropertyObj.attributes.Nullable === 'false';
        const isList = navigationPropertyTypeRef.startsWith('Collection(');
        if (isList) {
          const singularField: ObjectTypeComposerFieldConfigDefinition<any, unknown> = {
            type: getTypeNameFromRef({
              typeRef: navigationPropertyTypeRef,
              isInput: false,
              isRequired,
            })
              .replace('[', '')
              .replace(']', ''),
            args: {
              ...commonArgs,
              id: {
                type: 'ID',
              },
            },
            extensions: { navigationPropertyObj },
            resolve: async (root, args, context, info) => {
              if (navigationPropertyName in root) {
                return root[navigationPropertyName];
              }
              const url = new URL(root['@odata.id']);
              url.href = urljoin(url.href, '/' + navigationPropertyName);
              const returnType = info.returnType as GraphQLObjectType;
              const { entityInfo } = returnType.extensions as EntityTypeExtensions;
              addIdentifierToUrl(url, entityInfo.identifierFieldName, entityInfo.identifierFieldTypeRef, args);
              const parsedInfoFragment = parseResolveInfo(info) as ResolveTree;
              const searchParams = prepareSearchParams(parsedInfoFragment, info.schema, config);
              searchParams?.forEach((value, key) => {
                url.searchParams.set(key, value);
              });
              const urlString = getUrlString(url);
              const method = 'GET';
              const request = new Request(urlString, {
                method,
                headers: headersFactory({ root, args, context, info, env }, method),
              });
              const response = await context[contextDataloaderName].load(request);
              const responseText = await response.text();
              return handleResponseText(responseText, urlString, info);
            },
          };
          const pluralField: ObjectTypeComposerFieldConfigDefinition<any, unknown> = {
            type: getTypeNameFromRef({
              typeRef: navigationPropertyTypeRef,
              isInput: false,
              isRequired,
            }),
            args: {
              ...commonArgs,
              queryOptions: { type: 'QueryOptions' },
            },
            extensions: { navigationPropertyObj },
            resolve: async (root, args, context, info) => {
              if (navigationPropertyName in root) {
                return root[navigationPropertyName];
              }
              const url = new URL(root['@odata.id']);
              url.href = urljoin(url.href, '/' + navigationPropertyName);
              const parsedInfoFragment = parseResolveInfo(info) as ResolveTree;
              const searchParams = prepareSearchParams(parsedInfoFragment, info.schema, config);
              searchParams?.forEach((value, key) => {
                url.searchParams.set(key, value);
              });
              const urlString = getUrlString(url);
              const method = 'GET';
              const request = new Request(urlString, {
                method,
                headers: headersFactory({ root, args, context, info, env }, method),
              });
              const response = await context[contextDataloaderName].load(request);
              const responseText = await response.text();
              return handleResponseText(responseText, urlString, info);
            },
          };
          abstractType?.addFields({
            [navigationPropertyName]: pluralField,
            [`${navigationPropertyName}ById`]: singularField,
          });
          outputType.addFields({
            [navigationPropertyName]: pluralField,
            [`${navigationPropertyName}ById`]: singularField,
          });
        } else {
          const field: ObjectTypeComposerFieldConfigDefinition<any, unknown> = {
            type: getTypeNameFromRef({
              typeRef: navigationPropertyTypeRef,
              isInput: false,
              isRequired,
            }),
            args: {
              ...commonArgs,
            },
            extensions: { navigationPropertyObj },
            resolve: async (root, args, context, info) => {
              if (navigationPropertyName in root) {
                return root[navigationPropertyName];
              }
              const url = new URL(root['@odata.id']);
              url.href = urljoin(url.href, '/' + navigationPropertyName);
              const parsedInfoFragment = parseResolveInfo(info) as ResolveTree;
              const searchParams = prepareSearchParams(parsedInfoFragment, info.schema, config);
              searchParams?.forEach((value, key) => {
                url.searchParams.set(key, value);
              });
              const urlString = getUrlString(url);
              const method = 'GET';
              const request = new Request(urlString, {
                method,
                headers: headersFactory({ root, args, context, info, env }, method),
              });
              const response = await context[contextDataloaderName].load(request);
              const responseText = await response.text();
              return handleResponseText(responseText, urlString, info);
            },
          };
          abstractType?.addFields({
            [navigationPropertyName]: field,
          });
          outputType.addFields({
            [navigationPropertyName]: field,
          });
        }
      });
      if (isOpenType || outputType.getFieldNames().length === 0) {
        extensions.entityInfo.isOpenType = true;
        inputType.addFields({
          rest: {
            type: 'JSON',
          },
        });
        abstractType?.addFields({
          rest: {
            type: 'JSON',
            resolve: (root: any) => root,
          },
        });
        outputType.addFields({
          rest: {
            type: 'JSON',
            resolve: (root: any) => root,
          },
        });
      }
      const updateInputType = inputType.clone(`${entityTypeName}UpdateInput`);
      updateInputType.getFieldNames()?.forEach(fieldName => updateInputType.makeOptional(fieldName));
      // Types might be considered as unused implementations of interfaces so we must prevent that
      schemaComposer.addSchemaMustHaveType(outputType);
    });

    const handleUnboundFunctionObj = (unboundFunctionObj: any) => {
      const functionName = unboundFunctionObj.attributes.Name;
      const returnTypeRef = unboundFunctionObj.ReturnType[0].attributes.Type;
      const returnType = getTypeNameFromRef({
        typeRef: returnTypeRef,
        isInput: false,
        isRequired: false,
      });
      schemaComposer.Query.addFields({
        [functionName]: {
          type: returnType,
          args: {
            ...commonArgs,
          },
          resolve: async (root, args, context, info) => {
            const url = new URL(baseUrl);
            url.href = urljoin(url.href, '/' + functionName);
            url.href += `(${Object.entries(args)
              .filter(argEntry => argEntry[0] !== 'queryOptions')
              .map(argEntry => argEntry.join(' = '))
              .join(', ')})`;
            const parsedInfoFragment = parseResolveInfo(info) as ResolveTree;
            const searchParams = prepareSearchParams(parsedInfoFragment, info.schema, config);
            searchParams?.forEach((value, key) => {
              url.searchParams.set(key, value);
            });
            const urlString = getUrlString(url);
            const method = 'GET';
            const request = new Request(urlString, {
              method,
              headers: headersFactory({ root, args, context, info, env }, method),
            });
            const response = await context[contextDataloaderName].load(request);
            const responseText = await response.text();
            return handleResponseText(responseText, urlString, info);
          },
        },
      });
      unboundFunctionObj.Parameter?.forEach((parameterObj: any) => {
        const parameterName = parameterObj.attributes.Name;
        const parameterTypeRef = parameterObj.attributes.Type;
        const isRequired = parameterObj.attributes.Nullable === 'false';
        const parameterType = getTypeNameFromRef({
          typeRef: parameterTypeRef,
          isInput: true,
          isRequired,
        });
        schemaComposer.Query.addFieldArgs(functionName, {
          [parameterName]: {
            type: parameterType,
          },
        });
      });
    };

    const handleBoundFunctionObj = (boundFunctionObj: any) => {
      const functionName = boundFunctionObj.attributes.Name;
      const functionRef = schemaNamespace + '.' + functionName;
      const returnTypeRef = boundFunctionObj.ReturnType[0].attributes.Type;
      const returnType = getTypeNameFromRef({
        typeRef: returnTypeRef,
        isInput: false,
        isRequired: false,
      });
      const args: ObjectTypeComposerArgumentConfigMapDefinition<any> = {
        ...commonArgs,
      };
      // eslint-disable-next-line prefer-const
      let entitySetPath = boundFunctionObj.attributes.EntitySetPath;
      boundFunctionObj.Parameter?.forEach((parameterObj: any) => {
        const parameterName = parameterObj.attributes.Name;
        const parameterTypeRef = parameterObj.attributes.Type;
        const isRequired = parameterObj.attributes.Nullable === 'false';
        const parameterTypeName = getTypeNameFromRef({
          typeRef: parameterTypeRef,
          isInput: true,
          isRequired,
        });
        // If entitySetPath is not available, take first parameter as entity
        entitySetPath = entitySetPath || parameterName;
        if (entitySetPath === parameterName) {
          const boundEntityTypeName = getTypeNameFromRef({
            typeRef: parameterTypeRef,
            isInput: false,
            isRequired: false,
          })
            .replace('[', '')
            .replace(']', '');
          const boundEntityType = schemaComposer.getAnyTC(boundEntityTypeName) as InterfaceTypeComposer;
          const boundEntityOtherType = getTCByTypeNames(
            'I' + boundEntityTypeName,
            'T' + boundEntityTypeName
          ) as InterfaceTypeComposer;
          const field: ObjectTypeComposerFieldConfigDefinition<any, any, any> = {
            type: returnType,
            args,
            resolve: async (root, args, context, info) => {
              const url = new URL(root['@odata.id']);
              url.href = urljoin(url.href, '/' + functionRef);
              const parsedInfoFragment = parseResolveInfo(info) as ResolveTree;
              const searchParams = prepareSearchParams(parsedInfoFragment, info.schema, config);
              searchParams?.forEach((value, key) => {
                url.searchParams.set(key, value);
              });
              const urlString = getUrlString(url);
              const method = 'GET';
              const request = new Request(urlString, {
                method,
                headers: headersFactory({ root, args, context, info, env }, method),
              });
              const response = await context[contextDataloaderName].load(request);
              const responseText = await response.text();
              return handleResponseText(responseText, urlString, info);
            },
          };
          boundEntityType.addFields({
            [functionName]: field,
          });
          boundEntityOtherType?.addFields({
            [functionName]: field,
          });
        }
        args[parameterName] = {
          type: parameterTypeName,
        };
      });
    };

    schemaObj.Function?.forEach((functionObj: any) => {
      if (functionObj.attributes?.IsBound === 'true') {
        handleBoundFunctionObj(functionObj);
      } else {
        handleUnboundFunctionObj(functionObj);
      }
    });

    const handleUnboundActionObj = (unboundActionObj: any) => {
      const actionName = unboundActionObj.attributes.Name;
      schemaComposer.Mutation.addFields({
        [actionName]: {
          type: 'JSON',
          args: {
            ...commonArgs,
          },
          resolve: async (root, args, context, info) => {
            const url = new URL(baseUrl);
            url.href = urljoin(url.href, '/' + actionName);
            const urlString = getUrlString(url);
            const method = 'POST';
            const request = new Request(urlString, {
              method,
              headers: headersFactory({ root, args, context, info, env }, method),
              body: jsonFlatStringify(args),
            });
            const response = await context[contextDataloaderName].load(request);
            const responseText = await response.text();
            return handleResponseText(responseText, urlString, info);
          },
        },
      });

      unboundActionObj.Parameter?.forEach((parameterObj: any) => {
        const parameterName = parameterObj.attributes.Name;
        const parameterTypeRef = parameterObj.attributes.Type;
        const isRequired = parameterObj.attributes.Nullable === 'false';
        const parameterType = getTypeNameFromRef({
          typeRef: parameterTypeRef,
          isInput: true,
          isRequired,
        });
        schemaComposer.Mutation.addFieldArgs(actionName, {
          [parameterName]: {
            type: parameterType,
          },
        });
      });
    };

    const handleBoundActionObj = (boundActionObj: any) => {
      const actionName = boundActionObj.attributes.Name;
      const actionRef = schemaNamespace + '.' + actionName;
      const args: ObjectTypeComposerArgumentConfigMapDefinition<any> = {
        ...commonArgs,
      };
      let entitySetPath = boundActionObj.attributes.EntitySetPath;
      let boundField: ObjectTypeComposerFieldConfigDefinition<any, any, any>;
      let boundEntityTypeName: string;
      boundActionObj.Parameter?.forEach((parameterObj: any) => {
        const parameterName = parameterObj.attributes.Name;
        const parameterTypeRef = parameterObj.attributes.Type;
        const isRequired = parameterObj.attributes.Nullable === 'false';
        const parameterTypeName = getTypeNameFromRef({
          typeRef: parameterTypeRef,
          isInput: true,
          isRequired,
        });
        // If entitySetPath is not available, take first parameter as entity
        entitySetPath = entitySetPath || parameterName;
        if (entitySetPath === parameterName) {
          boundEntityTypeName = getTypeNameFromRef({
            typeRef: parameterTypeRef,
            isInput: false,
            isRequired: false,
          })
            .replace('[', '')
            .replace(']', ''); // Todo temp workaround
          boundField = {
            type: 'JSON',
            args,
            resolve: async (root, args, context, info) => {
              const url = new URL(root['@odata.id']);
              url.href = urljoin(url.href, '/' + actionRef);
              const urlString = getUrlString(url);
              const method = 'POST';
              const request = new Request(urlString, {
                method,
                headers: headersFactory({ root, args, context, info, env }, method),
                body: jsonFlatStringify(args),
              });
              const response = await context[contextDataloaderName].load(request);
              const responseText = await response.text();
              return handleResponseText(responseText, urlString, info);
            },
          };
        }
        args[parameterName] = {
          type: parameterTypeName,
        };
      });
      const boundEntityType = schemaComposer.getAnyTC(boundEntityTypeName) as InterfaceTypeComposer;
      boundEntityType.addFields({
        [actionName]: boundField,
      });
      const otherType = getTCByTypeNames(
        `I${boundEntityTypeName}`,
        `T${boundEntityTypeName}`
      ) as InterfaceTypeComposer;
      otherType?.addFields({
        [actionName]: boundField,
      });
    };

    schemaObj.Action?.forEach((actionObj: any) => {
      if (actionObj.attributes?.IsBound === 'true') {
        handleBoundActionObj(actionObj);
      } else {
        handleUnboundActionObj(actionObj);
      }
    });

    // Rearrange fields for base types and implementations
    typesWithBaseType?.forEach((typeObj: any) => {
      const typeName = buildName({
        schemaNamespace,
        name: typeObj.attributes.Name,
      });
      const inputType = schemaComposer.getITC(typeName + 'Input') as InputTypeComposer;
      const abstractType = getTCByTypeNames('I' + typeName, typeName) as InterfaceTypeComposer;
      const outputType = getTCByTypeNames('T' + typeName, typeName) as ObjectTypeComposer;
      const baseTypeRef = typeObj.attributes.BaseType;
      const { entityInfo, eventEmitter } = outputType.getExtensions() as EntityTypeExtensions;
      const baseTypeName = getTypeNameFromRef({
        typeRef: baseTypeRef,
        isInput: false,
        isRequired: false,
      });
      const baseInputType = schemaComposer.getAnyTC(baseTypeName + 'Input') as InputTypeComposer;
      const baseAbstractType = getTCByTypeNames('I' + baseTypeName, baseTypeName) as InterfaceTypeComposer;
      const baseOutputType = getTCByTypeNames('T' + baseTypeName, baseTypeName) as ObjectTypeComposer;
      const { entityInfo: baseEntityInfo, eventEmitter: baseEventEmitter } =
        baseOutputType.getExtensions() as EntityTypeExtensions;
      const baseEventEmitterListener = () => {
        inputType.addFields(baseInputType.getFields());
        entityInfo.identifierFieldName = baseEntityInfo.identifierFieldName || entityInfo.identifierFieldName;
        entityInfo.identifierFieldTypeRef =
          baseEntityInfo.identifierFieldTypeRef || entityInfo.identifierFieldTypeRef;
        entityInfo.actualFields.unshift(...baseEntityInfo.actualFields);
        abstractType?.addFields(baseAbstractType?.getFields());
        outputType.addFields(baseOutputType.getFields());
        if (baseAbstractType instanceof InterfaceTypeComposer) {
          // abstractType.addInterface(baseAbstractType.getTypeName());
          outputType.addInterface(baseAbstractType.getTypeName());
        }
        eventEmitter.emit('onFieldChange');
      };
      baseEventEmitter.on('onFieldChange', baseEventEmitterListener);
      baseEventEmitterListener();
    });

    schemaObj.EntityContainer?.forEach((entityContainerObj: any) => {
      entityContainerObj.Singleton?.forEach((singletonObj: any) => {
        const singletonName = singletonObj.attributes.Name;
        const singletonTypeRef = singletonObj.attributes.Type;
        const singletonTypeName = getTypeNameFromRef({
          typeRef: singletonTypeRef,
          isInput: false,
          isRequired: false,
        });
        schemaComposer.Query.addFields({
          [singletonName]: {
            type: singletonTypeName,
            args: {
              ...commonArgs,
            },
            resolve: async (root, args, context, info) => {
              const url = new URL(baseUrl);
              url.href = urljoin(url.href, '/' + singletonName);
              const parsedInfoFragment = parseResolveInfo(info) as ResolveTree;
              const searchParams = prepareSearchParams(parsedInfoFragment, info.schema, config);
              searchParams?.forEach((value, key) => {
                url.searchParams.set(key, value);
              });
              const urlString = getUrlString(url);
              const method = 'GET';
              const request = new Request(urlString, {
                method,
                headers: headersFactory({ root, args, context, info, env }, method),
              });
              const response = await context[contextDataloaderName].load(request);
              const responseText = await response.text();
              return handleResponseText(responseText, urlString, info);
            },
          },
        });
      });

      entityContainerObj?.EntitySet?.forEach((entitySetObj: any) => {
        const entitySetName = entitySetObj.attributes.Name;
        const entitySetTypeRef = entitySetObj.attributes.EntityType;
        const entityTypeName = getTypeNameFromRef({
          typeRef: entitySetTypeRef,
          isInput: false,
          isRequired: false,
        });
        const entityOutputTC = getTCByTypeNames('I' + entityTypeName, entityTypeName) as
          | InterfaceTypeComposer
          | ObjectTypeComposer;
        const { entityInfo } = entityOutputTC.getExtensions() as EntityTypeExtensions;
        const identifierFieldName = entityInfo.identifierFieldName;
        const identifierFieldTypeRef = entityInfo.identifierFieldTypeRef;
        const identifierFieldTypeName = entityOutputTC.getFieldTypeName(identifierFieldName);
        const typeName = entityOutputTC.getTypeName();
        const commonFields: Record<string, ObjectTypeComposerFieldConfigDefinition<any, any>> = {
          [entitySetName]: {
            type: `[${typeName}]`,
            args: {
              ...commonArgs,
              queryOptions: { type: 'QueryOptions' },
            },
            resolve: async (root, args, context, info) => {
              const url = new URL(baseUrl);
              url.href = urljoin(url.href, '/' + entitySetName);
              const parsedInfoFragment = parseResolveInfo(info) as ResolveTree;
              const searchParams = prepareSearchParams(parsedInfoFragment, info.schema, config);
              searchParams?.forEach((value, key) => {
                url.searchParams.set(key, value);
              });
              const urlString = getUrlString(url);
              const method = 'GET';
              const request = new Request(urlString, {
                method,
                headers: headersFactory({ root, args, context, info, env }, method),
              });
              const response = await context[contextDataloaderName].load(request);
              const responseText = await response.text();
              return handleResponseText(responseText, urlString, info);
            },
          },
          [`${entitySetName}By${identifierFieldName}`]: {
            type: typeName,
            args: {
              ...commonArgs,
              [identifierFieldName]: {
                type: identifierFieldTypeName,
              },
            },
            resolve: async (root, args, context, info) => {
              const url = new URL(baseUrl);
              url.href = urljoin(url.href, '/' + entitySetName);
              addIdentifierToUrl(url, identifierFieldName, identifierFieldTypeRef, args);
              const parsedInfoFragment = parseResolveInfo(info) as ResolveTree;
              const searchParams = prepareSearchParams(parsedInfoFragment, info.schema, config);
              searchParams?.forEach((value, key) => {
                url.searchParams.set(key, value);
              });
              const urlString = getUrlString(url);
              const method = 'GET';
              const request = new Request(urlString, {
                method,
                headers: headersFactory({ root, args, context, info, env }, method),
              });
              const response = await context[contextDataloaderName].load(request);
              const responseText = await response.text();
              return handleResponseText(responseText, urlString, info);
            },
          },
        };
        schemaComposer.Query.addFields({
          ...commonFields,
          [`${entitySetName}Count`]: {
            type: 'Int',
            args: {
              ...commonArgs,
              queryOptions: { type: 'QueryOptions' },
            },
            resolve: async (root, args, context, info) => {
              const url = new URL(baseUrl);
              url.href = urljoin(url.href, `/${entitySetName}/$count`);
              const urlString = getUrlString(url);
              const method = 'GET';
              const request = new Request(urlString, {
                method,
                headers: headersFactory({ root, args, context, info, env }, method),
              });
              const response = await context[contextDataloaderName].load(request);
              const responseText = await response.text();
              return responseText;
            },
          },
        });
        schemaComposer.Mutation.addFields({
          ...commonFields,
          [`create${entitySetName}`]: {
            type: typeName,
            args: {
              ...commonArgs,
              input: {
                type: entityTypeName + 'Input',
              },
            },
            resolve: async (root, args, context, info) => {
              const url = new URL(baseUrl);
              url.href = urljoin(url.href, '/' + entitySetName);
              const urlString = getUrlString(url);
              rebuildOpenInputObjects(args.input);
              const method = 'POST';
              const request = new Request(urlString, {
                method,
                headers: headersFactory({ root, args, context, info, env }, method),
                body: jsonFlatStringify(args.input),
              });
              const response = await context[contextDataloaderName].load(request);
              const responseText = await response.text();
              return handleResponseText(responseText, urlString, info);
            },
          },
          [`delete${entitySetName}By${identifierFieldName}`]: {
            type: 'JSON',
            args: {
              ...commonArgs,
              [identifierFieldName]: {
                type: identifierFieldTypeName,
              },
            },
            resolve: async (root, args, context, info) => {
              const url = new URL(baseUrl);
              url.href = urljoin(url.href, '/' + entitySetName);
              addIdentifierToUrl(url, identifierFieldName, identifierFieldTypeRef, args);
              const urlString = getUrlString(url);
              const method = 'DELETE';
              const request = new Request(urlString, {
                method,
                headers: headersFactory({ root, args, context, info, env }, method),
              });
              const response = await context[contextDataloaderName].load(request);
              const responseText = await response.text();
              return handleResponseText(responseText, urlString, info);
            },
          },
          [`update${entitySetName}By${identifierFieldName}`]: {
            type: typeName,
            args: {
              ...commonArgs,
              [identifierFieldName]: {
                type: identifierFieldTypeName,
              },
              input: {
                type: entityTypeName + 'UpdateInput',
              },
            },
            resolve: async (root, args, context, info) => {
              const url = new URL(baseUrl);
              url.href = urljoin(url.href, '/' + entitySetName);
              addIdentifierToUrl(url, identifierFieldName, identifierFieldTypeRef, args);
              const urlString = getUrlString(url);
              rebuildOpenInputObjects(args.input);
              const method = 'PATCH';
              const request = new Request(urlString, {
                method,
                headers: headersFactory({ root, args, context, info, env }, method),
                body: jsonFlatStringify(args.input),
              });
              const response = await context[contextDataloaderName].load(request);
              const responseText = await response.text();
              return handleResponseText(responseText, urlString, info);
            },
          },
        });
      });
    });
  });
  // end schemas.forEach loop

  // graphql-compose doesn't add @defer and @stream to the schema
  specifiedDirectives.forEach(directive => schemaComposer.addDirective(directive));

  const schema = schemaComposer.buildSchema();
  return schema;
}


function initSchemaComposer() {
  const schemaComposer = new SchemaComposer();
  schemaComposer.add(GraphQLBigInt);
  schemaComposer.add(GraphQLGUID);
  schemaComposer.add(GraphQLDateTime);
  schemaComposer.add(GraphQLJSON);
  schemaComposer.add(GraphQLByte);
  schemaComposer.add(GraphQLDate);
  schemaComposer.add(GraphQLISO8601Duration);

  return schemaComposer;
}

function prepareSearchParams(fragment: ResolveTree, schema: GraphQLSchema, config: YamlConfig.ODataHandler) {
  const fragmentTypeNames = Object.keys(fragment.fieldsByTypeName) as string[];
  const returnType = schema.getType(fragmentTypeNames[0]);
  const { args, fields } = simplifyParsedResolveInfoFragmentWithType(fragment, returnType);
  const searchParams = new URLSearchParams();
  if ('queryOptions' in args) {
    const { queryOptions } = args as any;
    for (const param in queryOptionsFields) {
      if (param in queryOptions) {
        searchParams.set('$' + param, queryOptions[param]);
      }
    }
  }

  // $select doesn't work with inherited types' fields. So if there is an inline fragment for
  // implemented types, we cannot use $select
  const isSelectable = !isAbstractType(returnType);

  if (isSelectable) {
    const { entityInfo } = returnType.extensions as EntityTypeExtensions;
    const selectionFields: string[] = [];
    const expandedFields: string[] = [];
    for (const fieldName in fields) {
      if (entityInfo.actualFields.includes(fieldName)) {
        selectionFields.push(fieldName);
      }
      if (config.expandNavProps && entityInfo.navigationFields.includes(fieldName)) {
        const searchParams = prepareSearchParams(fields[fieldName], schema, config);
        const searchParamsStr = decodeURIComponent(searchParams.toString());
        expandedFields.push(`${fieldName}(${searchParamsStr.split('&').join(';')})`);
        selectionFields.push(fieldName);
      }
    }
    if (!selectionFields.includes(entityInfo.identifierFieldName)) {
      selectionFields.push(entityInfo.identifierFieldName);
    }
    if (selectionFields.length) {
      searchParams.set('$select', selectionFields.join(','));
    }
    if (expandedFields.length) {
      searchParams.set('$expand', expandedFields.join(','));
    }
  }
  return searchParams;
}
