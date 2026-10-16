# Playground Lambda Web Functions

Este repositorio va a contar con varios ejemplos de casos de usos utiles sobre el nuevo tipo de Lambda que actua como servidor http.

## Ejemplos

| Caso de Uso | Descripción | Runtime |
| --- | --- | --- |
| [Agente con streaming](agent-weather-sse/) | Agente de IA (Strands harness + Express) que responde sobre el clima y planifica viajes, con streaming de tokens por SSE y sesiones persistidas en S3. | `nodejs24.x` |
| [BFF + microservicios](bff-orders-inventory/) | BFF de pedidos (público) que reserva stock en un servicio de inventario (privado, IamAuth) con una llamada firmada SigV4, usando DynamoDB. | `nodejs24.x` |


# Licencia

Este proyecto está bajo la Licencia MIT. Consulta el archivo [LICENSE](LICENSE) para más detalles.