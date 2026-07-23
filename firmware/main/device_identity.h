#ifndef SPINEGUARD_DEVICE_IDENTITY_H
#define SPINEGUARD_DEVICE_IDENTITY_H

#include <stdbool.h>
#include <stddef.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

#define SPINEGUARD_DEVICE_ID_CAPACITY 16
#define SPINEGUARD_DEVICE_NAME_CAPACITY 64
#define SPINEGUARD_DEVICE_SECRET_CAPACITY 65
#define SPINEGUARD_CLAIM_CODE_CAPACITY 7

/* Initialize stable MAC-derived id and NVS-backed name/secret/claim code. */
esp_err_t device_identity_init(void);

const char *device_identity_id(void);
void device_identity_copy_name(char *buffer, size_t buffer_size);
void device_identity_copy_secret(char *buffer, size_t buffer_size);
void device_identity_copy_claim_code(char *buffer, size_t buffer_size);

bool device_identity_name_is_valid(const char *name);
esp_err_t device_identity_set_name(const char *name);
esp_err_t device_identity_rotate_claim_code(void);

#ifdef __cplusplus
}
#endif

#endif
