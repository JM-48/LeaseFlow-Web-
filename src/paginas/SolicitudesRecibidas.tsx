import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ROLES } from "../config/apiConfig";
import { getErrorMessage } from "../core/errors";
import { solicitudService, registroService, propiedadService } from "../api";
import type { SolicitudArriendoDTO, CrearRegistroRequest } from "../types";

// ─────────────────────────────────────────────
// Tipos locales
// ─────────────────────────────────────────────
type EstadoFiltro = "TODAS" | "PENDIENTE" | "ACEPTADA" | "RECHAZADA";

interface ModalRegistro {
  solicitud: SolicitudArriendoDTO;
  fechaInicio: string;
  fechaFin: string;
  montoMensual: string;
  error: string | null;
  submitting: boolean;
}

interface SolicitudesRecibidasProps {
  // "MINE": solo las solicitudes de las propiedades del usuario logueado (propietario, o admin actuando como propietario)
  // "ALL": gestor global, todas las solicitudes existentes (solo tiene sentido para ADMIN)
  scope?: "MINE" | "ALL";
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
function badgeClase(estado: string): string {
  if (estado === "ACEPTADA") return "bg-success";
  if (estado === "RECHAZADA") return "bg-danger";
  return "bg-warning text-dark";
}

function hoy(): string {
  return new Date().toISOString().split("T")[0];
}

// ─────────────────────────────────────────────
// Componente
// ─────────────────────────────────────────────
const SolicitudesRecibidas: React.FC<SolicitudesRecibidasProps> = ({ scope = "MINE" }) => {
  const navigate = useNavigate();
  const userRole = (localStorage.getItem("userRole") || "").toUpperCase();
  const userId = Number(localStorage.getItem("userId") || "0");
  const esAdmin = userRole === ROLES.ADMIN;
  const esGestorGlobal = scope === "ALL" && esAdmin;

  // ── Estado principal ──────────────────────
  const [solicitudes, setSolicitudes] = useState<SolicitudArriendoDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notificacion, setNotificacion] = useState<{
    variant: "success" | "danger";
    message: string;
  } | null>(null);

  // ── Estado de acciones ────────────────────
  const [processingId, setProcessingId] = useState<number | null>(null);
  const [confirmRechazarId, setConfirmRechazarId] = useState<number | null>(null);
  const [filtro, setFiltro] = useState<EstadoFiltro>("PENDIENTE");

  // ── Modal para crear registro ─────────────
  const [modal, setModal] = useState<ModalRegistro | null>(null);

  // ── Auto-dismiss notificación ─────────────
  useEffect(() => {
    if (!notificacion) return;
    const id = window.setTimeout(() => setNotificacion(null), 3000);
    return () => window.clearTimeout(id);
  }, [notificacion]);

  // ─────────────────────────────────────────
  // Carga de datos
  // ─────────────────────────────────────────
  const fetchSolicitudes = useCallback(async () => {
    if (localStorage.getItem("isLoggedIn") !== "true") {
      navigate("/login");
      return;
    }
    if (userRole !== ROLES.PROPIETARIO && userRole !== ROLES.ADMIN) {
      setLoading(false);
      setError("Acceso denegado. Esta sección es solo para propietarios.");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      if (esGestorGlobal) {
        // ADMIN en modo gestor global: todas las solicitudes del sistema
        const data = await solicitudService.listar(true);
        setSolicitudes(Array.isArray(data) ? data : []);
        return;
      }

      // PROPIETARIO (o ADMIN viendo sus propias propiedades):
      // el backend no filtra /api/solicitudes por propietario (solo por
      // arrendatario), así que primero traemos sus propiedades y luego
      // las solicitudes recibidas en cada una.
      const propiedades = await propiedadService.listarPorPropietario(userId, false);

      if (!propiedades || propiedades.length === 0) {
        setSolicitudes([]);
        return;
      }

      const resultados = await Promise.all(
        propiedades.map((p) =>
          solicitudService.obtenerPorPropiedad(p.id, true).catch(() => [])
        )
      );

      setSolicitudes(resultados.flat());
    } catch (err: unknown) {
      setError(getErrorMessage(err, "No se pudieron cargar las solicitudes."));
    } finally {
      setLoading(false);
    }
  }, [navigate, userId, userRole, esGestorGlobal]);

  useEffect(() => {
    fetchSolicitudes();
  }, [fetchSolicitudes]);

  // ─────────────────────────────────────────
  // Filtrado y orden
  // ─────────────────────────────────────────
  const solicitudesFiltradas = useMemo(() => {
    const base =
      filtro === "TODAS" ? solicitudes : solicitudes.filter((s) => s.estado === filtro);
    return [...base].sort(
      (a, b) => new Date(b.fechaSolicitud).getTime() - new Date(a.fechaSolicitud).getTime()
    );
  }, [solicitudes, filtro]);

  const conteos = useMemo(
    () => ({
      TODAS: solicitudes.length,
      PENDIENTE: solicitudes.filter((s) => s.estado === "PENDIENTE").length,
      ACEPTADA: solicitudes.filter((s) => s.estado === "ACEPTADA").length,
      RECHAZADA: solicitudes.filter((s) => s.estado === "RECHAZADA").length,
    }),
    [solicitudes]
  );

  // ─────────────────────────────────────────
  // Acciones
  // ─────────────────────────────────────────
  const rechazar = async (id: number) => {
    try {
      setProcessingId(id);
      setConfirmRechazarId(null);
      const updated = await solicitudService.actualizarEstado(id, "RECHAZADA");
      setSolicitudes((prev) => prev.map((s) => (s.id === id ? updated : s)));
      setNotificacion({ variant: "success", message: "Solicitud rechazada." });
    } catch (err: unknown) {
      setNotificacion({
        variant: "danger",
        message: getErrorMessage(err, "No se pudo rechazar la solicitud."),
      });
    } finally {
      setProcessingId(null);
    }
  };

  // Abre el modal para ingresar datos del registro
  const abrirModalAceptar = (solicitud: SolicitudArriendoDTO) => {
    setModal({
      solicitud,
      fechaInicio: hoy(),
      fechaFin: "",
      // Pre-rellena con el precio mensual de la propiedad si está disponible
      montoMensual: solicitud.propiedad?.precioMensual?.toString() ?? "",
      error: null,
      submitting: false,
    });
  };

  const cerrarModal = () => {
    if (modal?.submitting) return; // no cerrar mientras envía
    setModal(null);
  };

  // Acepta la solicitud y crea el registro de arriendo en un solo flujo
  const confirmarAceptar = async () => {
    if (!modal) return;

    // ── Validaciones del formulario ──────────
    const monto = parseFloat(modal.montoMensual);
    if (!modal.fechaInicio) {
      setModal((m) => m && { ...m, error: "La fecha de inicio es obligatoria." });
      return;
    }
    if (isNaN(monto) || monto <= 0) {
      setModal((m) => m && { ...m, error: "El monto mensual debe ser mayor a 0." });
      return;
    }
    if (modal.fechaFin && modal.fechaFin < modal.fechaInicio) {
      setModal((m) => m && { ...m, error: "La fecha de fin no puede ser anterior a la fecha de inicio." });
      return;
    }

    setModal((m) => m && { ...m, submitting: true, error: null });

    try {
      const solicitudId = modal.solicitud.id;

      // 1. Cambiar estado de la solicitud a ACEPTADA
      const solicitudActualizada = await solicitudService.actualizarEstado(solicitudId, "ACEPTADA");

      // 2. Crear el registro de arriendo
      const registroPayload: CrearRegistroRequest = {
        solicitudId,
        fechaInicio: modal.fechaInicio,
        montoMensual: monto,
        ...(modal.fechaFin ? { fechaFin: modal.fechaFin } : {}),
      };
      await registroService.crear(registroPayload);

      // 3. Actualizar lista local
      setSolicitudes((prev) =>
        prev.map((s) => (s.id === solicitudId ? solicitudActualizada : s))
      );

      setModal(null);
      setNotificacion({
        variant: "success",
        message: "¡Solicitud aceptada y contrato de arriendo creado exitosamente!",
      });
    } catch (err: unknown) {
      setModal((m) =>
        m && {
          ...m,
          submitting: false,
          error: getErrorMessage(err, "No se pudo completar la operación. Intenta nuevamente."),
        }
      );
    }
  };

  // ─────────────────────────────────────────
  // Guard de acceso
  // ─────────────────────────────────────────
  if (userRole !== ROLES.PROPIETARIO && userRole !== ROLES.ADMIN) {
    return (
      <div className="container my-5">
        <div className="alert alert-danger">Acceso denegado. Esta sección es solo para propietarios.</div>
      </div>
    );
  }

  // ─────────────────────────────────────────
  // Textos de encabezado según scope
  // ─────────────────────────────────────────
  const titulo = esGestorGlobal ? "Gestor de Solicitudes" : "Solicitudes Recibidas";
  const subtitulo = esGestorGlobal
    ? "Vista administrativa: todas las solicitudes de arriendo del sistema."
    : "Gestiona las solicitudes de arriendo que han recibido tus propiedades.";

  // ─────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────
  return (
    <div className="container my-5">
      {/* ── Notificación flotante ── */}
      {notificacion && (
        <div className="position-fixed top-0 end-0 p-3" style={{ zIndex: 1080 }}>
          <div className={`alert alert-${notificacion.variant} shadow-sm mb-0`} role="alert">
            {notificacion.message}
          </div>
        </div>
      )}

      {/* ── Encabezado ── */}
      <div className="mb-4">
        <h1 className="fw-bold mb-1">{titulo}</h1>
        <p className="text-muted mb-0">{subtitulo}</p>
      </div>

      {error && <div className="alert alert-danger">{error}</div>}

      {/* ── Tabs de filtro ── */}
      <ul className="nav nav-tabs mb-4">
        {(["PENDIENTE", "ACEPTADA", "RECHAZADA", "TODAS"] as EstadoFiltro[]).map((estado) => (
          <li className="nav-item" key={estado}>
            <button
              type="button"
              className={`nav-link${filtro === estado ? " active fw-semibold" : ""}`}
              onClick={() => setFiltro(estado)}
            >
              {estado === "TODAS" ? "Todas" : estado.charAt(0) + estado.slice(1).toLowerCase()}
              <span
                className={`ms-2 badge rounded-pill ${
                  estado === "PENDIENTE"
                    ? "bg-warning text-dark"
                    : estado === "ACEPTADA"
                    ? "bg-success"
                    : estado === "RECHAZADA"
                    ? "bg-danger"
                    : "bg-secondary"
                }`}
              >
                {conteos[estado]}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {/* ── Contenido ── */}
      {loading ? (
        <div className="text-center my-5">
          <div className="spinner-border text-primary" role="status" />
          <p className="mt-2">Cargando solicitudes...</p>
        </div>
      ) : solicitudesFiltradas.length === 0 ? (
        <div className="alert alert-secondary text-center">
          {filtro === "PENDIENTE"
            ? "No tienes solicitudes pendientes."
            : filtro === "TODAS"
            ? "Aún no has recibido solicitudes."
            : `No hay solicitudes con estado ${filtro.toLowerCase()}.`}
        </div>
      ) : (
        <div className="row g-4">
          {solicitudesFiltradas.map((s) => (
            <div className="col-12 col-lg-6" key={s.id}>
              <div className="card shadow-sm h-100">
                <div className="card-body">
                  {/* Encabezado de la tarjeta */}
                  <div className="d-flex justify-content-between align-items-start mb-3">
                    <div>
                      <h5 className="card-title mb-1">
                        {s.propiedad?.titulo || `Propiedad #${s.propiedadId}`}
                      </h5>
                      <p className="text-muted small mb-0">{s.propiedad?.direccion || ""}</p>
                    </div>
                    <span className={`badge ${badgeClase(s.estado)}`}>{s.estado}</span>
                  </div>

                  {/* Info del arrendatario */}
                  <div className="border rounded p-3 mb-3 bg-light">
                    <p className="fw-semibold mb-1 small text-uppercase text-muted">Solicitante</p>
                    {s.usuario ? (
                      <>
                        <p className="mb-0 fw-bold">
                          {s.usuario.pnombre} {s.usuario.snombre ?? ""} {s.usuario.papellido}
                        </p>
                        <p className="mb-0 small text-muted">{s.usuario.email}</p>
                        {s.usuario.ntelefono && (
                          <p className="mb-0 small text-muted">{s.usuario.ntelefono}</p>
                        )}
                      </>
                    ) : (
                      <p className="mb-0 text-muted small">Usuario #{s.usuarioId}</p>
                    )}
                  </div>

                  {/* Precio y fecha */}
                  <div className="d-flex justify-content-between align-items-center mb-3">
                    <div>
                      <p className="mb-0 small text-muted">Precio mensual</p>
                      <p className="fw-bold text-success mb-0">
                        {s.propiedad?.precioMensual
                          ? `$${s.propiedad.precioMensual.toLocaleString("es-CL")} ${s.propiedad.divisa ?? "CLP"}`
                          : "—"}
                      </p>
                    </div>
                    <div className="text-end">
                      <p className="mb-0 small text-muted">Fecha solicitud</p>
                      <p className="mb-0 small">{new Date(s.fechaSolicitud).toLocaleString("es-CL")}</p>
                    </div>
                  </div>

                  {/* Acciones — solo para PENDIENTE */}
                  {s.estado === "PENDIENTE" && (
                    <div className="d-flex gap-2 mt-auto">
                      {/* Botón Aceptar */}
                      <button
                        type="button"
                        className="btn btn-success btn-sm flex-fill"
                        disabled={processingId === s.id}
                        onClick={() => abrirModalAceptar(s)}
                      >
                        ✓ Aceptar
                      </button>

                      {/* Botón Rechazar con confirmación inline */}
                      {confirmRechazarId === s.id ? (
                        <>
                          <button
                            type="button"
                            className="btn btn-danger btn-sm flex-fill"
                            disabled={processingId === s.id}
                            onClick={() => rechazar(s.id)}
                          >
                            {processingId === s.id ? (
                              <>
                                <span className="spinner-border spinner-border-sm me-1" role="status" aria-hidden="true" />
                                Procesando...
                              </>
                            ) : (
                              "Confirmar rechazo"
                            )}
                          </button>
                          <button
                            type="button"
                            className="btn btn-outline-secondary btn-sm"
                            disabled={processingId === s.id}
                            onClick={() => setConfirmRechazarId(null)}
                          >
                            Cancelar
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-outline-danger btn-sm flex-fill"
                          disabled={processingId === s.id}
                          onClick={() => setConfirmRechazarId(s.id)}
                        >
                          ✗ Rechazar
                        </button>
                      )}
                    </div>
                  )}

                  {/* Mensaje para estados finales */}
                  {s.estado === "ACEPTADA" && (
                    <div className="alert alert-success py-2 mb-0 small mt-2">
                      Solicitud aceptada. El contrato de arriendo ha sido creado.
                    </div>
                  )}
                  {s.estado === "RECHAZADA" && (
                    <div className="alert alert-danger py-2 mb-0 small mt-2">
                      Solicitud rechazada.
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ══════════════════════════════════════════
          MODAL: Crear registro de arriendo
      ══════════════════════════════════════════ */}
      {modal && (
        <div
          className="modal d-block"
          tabIndex={-1}
          style={{
            backgroundColor: "rgba(0,0,0,0.6)",
            position: "fixed",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            zIndex: 1050,
          }}
        >
          <div className="modal-dialog modal-dialog-centered">
            <div className="modal-content">
              <div className="modal-header">
                <h5 className="modal-title">Aceptar solicitud y crear contrato</h5>
                <button
                  type="button"
                  className="btn-close"
                  onClick={cerrarModal}
                  disabled={modal.submitting}
                />
              </div>

              <div className="modal-body">
                {/* Resumen de la solicitud */}
                <div className="alert alert-info py-2 small mb-4">
                  <strong>{modal.solicitud.propiedad?.titulo || `Propiedad #${modal.solicitud.propiedadId}`}</strong>
                  <br />
                  Arrendatario:{" "}
                  {modal.solicitud.usuario
                    ? `${modal.solicitud.usuario.pnombre} ${modal.solicitud.usuario.papellido}`
                    : `Usuario #${modal.solicitud.usuarioId}`}
                </div>

                {modal.error && (
                  <div className="alert alert-danger py-2 small">{modal.error}</div>
                )}

                {/* Fecha de inicio */}
                <div className="mb-3">
                  <label className="form-label fw-semibold">
                    Fecha de inicio <span className="text-danger">*</span>
                  </label>
                  <input
                    type="date"
                    className="form-control"
                    value={modal.fechaInicio}
                    min={hoy()}
                    disabled={modal.submitting}
                    onChange={(e) =>
                      setModal((m) => m && { ...m, fechaInicio: e.target.value, error: null })
                    }
                  />
                </div>

                {/* Fecha de fin (opcional) */}
                <div className="mb-3">
                  <label className="form-label fw-semibold">
                    Fecha de fin{" "}
                    <span className="text-muted fw-normal">(opcional)</span>
                  </label>
                  <input
                    type="date"
                    className="form-control"
                    value={modal.fechaFin}
                    min={modal.fechaInicio || hoy()}
                    disabled={modal.submitting}
                    onChange={(e) =>
                      setModal((m) => m && { ...m, fechaFin: e.target.value, error: null })
                    }
                  />
                </div>

                {/* Monto mensual */}
                <div className="mb-3">
                  <label className="form-label fw-semibold">
                    Monto mensual (CLP) <span className="text-danger">*</span>
                  </label>
                  <div className="input-group">
                    <span className="input-group-text">$</span>
                    <input
                      type="number"
                      className="form-control"
                      value={modal.montoMensual}
                      min={1}
                      disabled={modal.submitting}
                      onChange={(e) =>
                        setModal((m) => m && { ...m, montoMensual: e.target.value, error: null })
                      }
                    />
                    <span className="input-group-text">CLP</span>
                  </div>
                  {modal.solicitud.propiedad?.precioMensual && (
                    <div className="form-text">
                      Precio publicado:{" "}
                      <strong>
                        ${modal.solicitud.propiedad.precioMensual.toLocaleString("es-CL")}
                      </strong>
                    </div>
                  )}
                </div>
              </div>

              <div className="modal-footer">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={cerrarModal}
                  disabled={modal.submitting}
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  className="btn btn-success"
                  onClick={confirmarAceptar}
                  disabled={modal.submitting}
                >
                  {modal.submitting ? (
                    <>
                      <span className="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true" />
                      Procesando...
                    </>
                  ) : (
                    "Confirmar y crear contrato"
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default SolicitudesRecibidas;
