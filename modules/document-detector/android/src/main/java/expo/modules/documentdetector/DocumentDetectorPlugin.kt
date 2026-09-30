package expo.modules.documentdetector

import android.graphics.ImageFormat
import com.mrousavy.camera.frameprocessors.Frame
import com.mrousavy.camera.frameprocessors.FrameProcessorPlugin
import com.mrousavy.camera.frameprocessors.VisionCameraProxy
import kotlin.math.max
import kotlin.math.min

/**
 * Finds the page in a camera frame.
 *
 * Android has no equivalent of Vision's rectangle detector without pulling in
 * OpenCV, so this is a deliberately small, allocation-light estimator that
 * runs on the luma plane alone:
 *
 *   1. Downsample Y to a coarse grid (the page is the dominant object, so
 *      detail is wasted work here).
 *   2. Threshold on brightness — paper under any usable light is the bright
 *      region, and Otsu's method picks the cut point without tuning.
 *   3. Take row and column occupancy profiles of the bright mask and trim in
 *      from each side until the profile crosses a fill threshold.
 *
 * The result is an axis-aligned quad, so on Android the app gets reliable
 * auto-capture and cropping but not a true keystone correction. Teachers who
 * need that on Android should switch Settings → "Use the system scanner",
 * which hands capture to ML Kit's document scanner.
 *
 * Returns [x0,y0, x1,y1, x2,y2, x3,y3, confidence] clockwise from top-left,
 * normalized 0–1 with the origin at top-left, or null when nothing looks like
 * a page.
 */
class DocumentDetectorPlugin(
  @Suppress("UNUSED_PARAMETER") proxy: VisionCameraProxy,
  @Suppress("UNUSED_PARAMETER") options: Map<String, Any>?,
) : FrameProcessorPlugin() {

  private companion object {
    /** Coarse grid the luma plane is sampled onto. */
    const val GRID_W = 96
    const val GRID_H = 96

    /**
     * A row or column counts as "page" once this fraction of it is bright.
     *
     * This also sets the smallest page the detector can see at all: the box
     * has to clear the threshold on both axes, so the floor is
     * FILL_THRESHOLD^2 of the frame. Keep it below autoCapture's MIN_AREA
     * (0.22) — otherwise a page held too far away is invisible here and the
     * user gets "Point at a test" instead of the "Move closer" hint.
     */
    const val FILL_THRESHOLD = 0.35f

    /** Below this share of the frame it is not the worksheet we want. */
    const val MIN_AREA = 0.14f

    /** Letter, A4 and legal all sit inside this range in either orientation. */
    const val MIN_ASPECT = 0.45f
    const val MAX_ASPECT = 2.4f
  }

  /** Reused between frames: at 8fps, reallocating these would churn the heap. */
  private val grid = IntArray(GRID_W * GRID_H)
  private val histogram = IntArray(256)
  private val rowFill = IntArray(GRID_H)
  private val colFill = IntArray(GRID_W)

  override fun callback(frame: Frame, arguments: Map<String, Any>?): Any? {
    val image = frame.image
    if (image.format != ImageFormat.YUV_420_888 && image.format != ImageFormat.YUV_422_888) {
      return null
    }

    val plane = image.planes.getOrNull(0) ?: return null
    val buffer = plane.buffer
    val rowStride = plane.rowStride
    val pixelStride = plane.pixelStride
    val width = image.width
    val height = image.height
    if (width <= 0 || height <= 0) return null

    // --- 1. Downsample the luma plane onto the coarse grid ------------------
    java.util.Arrays.fill(histogram, 0)
    for (gy in 0 until GRID_H) {
      val srcY = gy * height / GRID_H
      val rowBase = srcY * rowStride
      for (gx in 0 until GRID_W) {
        val srcX = gx * width / GRID_W
        val index = rowBase + srcX * pixelStride
        val luma = if (index < buffer.limit()) buffer.get(index).toInt() and 0xFF else 0
        grid[gy * GRID_W + gx] = luma
        histogram[luma]++
      }
    }

    // --- 2. Otsu threshold --------------------------------------------------
    val threshold = otsu(histogram, GRID_W * GRID_H)

    java.util.Arrays.fill(rowFill, 0)
    java.util.Arrays.fill(colFill, 0)
    var brightCount = 0
    for (gy in 0 until GRID_H) {
      for (gx in 0 until GRID_W) {
        if (grid[gy * GRID_W + gx] > threshold) {
          rowFill[gy]++
          colFill[gx]++
          brightCount++
        }
      }
    }

    // A frame that is almost all bright (pointed at a lit ceiling) or almost
    // all dark (lens covered) has no page in it.
    val brightFraction = brightCount.toFloat() / (GRID_W * GRID_H)
    if (brightFraction < MIN_AREA || brightFraction > 0.985f) return null

    // --- 3. Trim in from each edge -----------------------------------------
    val rowLimit = (GRID_W * FILL_THRESHOLD).toInt()
    val colLimit = (GRID_H * FILL_THRESHOLD).toInt()

    val top = firstAbove(rowFill, rowLimit, forward = true)
    val bottom = firstAbove(rowFill, rowLimit, forward = false)
    val left = firstAbove(colFill, colLimit, forward = true)
    val right = firstAbove(colFill, colLimit, forward = false)

    if (top < 0 || bottom < 0 || left < 0 || right < 0) return null
    if (bottom <= top || right <= left) return null

    val x0 = left.toFloat() / GRID_W
    val x1 = (right + 1).toFloat() / GRID_W
    val y0 = top.toFloat() / GRID_H
    val y1 = (bottom + 1).toFloat() / GRID_H

    val w = x1 - x0
    val h = y1 - y0
    val area = w * h
    if (area < MIN_AREA) return null

    val aspect = w / h
    if (aspect < MIN_ASPECT || aspect > MAX_ASPECT) return null

    // --- Confidence ---------------------------------------------------------
    // How solidly the detected box is actually filled with bright pixels. A
    // real page is near-uniform; a scattering of bright objects is not.
    var insideBright = 0
    var insideTotal = 0
    for (gy in top..bottom) {
      for (gx in left..right) {
        insideTotal++
        if (grid[gy * GRID_W + gx] > threshold) insideBright++
      }
    }
    val solidity = if (insideTotal == 0) 0f else insideBright.toFloat() / insideTotal

    // Contrast between the page and what surrounds it: a page lying on a
    // white desk is genuinely ambiguous and should not read as certain.
    val outsideTotal = GRID_W * GRID_H - insideTotal
    val outsideBright = brightCount - insideBright
    val outsideRatio = if (outsideTotal == 0) 1f else outsideBright.toFloat() / outsideTotal
    val separation = (solidity - outsideRatio).coerceIn(0f, 1f)

    val confidence = (solidity * 0.55f + separation * 0.45f).coerceIn(0f, 1f)
    if (confidence < 0.35f) return null

    // The grid is sampled in buffer space; rotate into display space so the
    // overlay lines up with what the user sees.
    val corners = rotateToDisplay(x0, y0, x1, y1, frame.orientation.toDegrees())

    return arrayListOf(
      corners[0], corners[1],
      corners[2], corners[3],
      corners[4], corners[5],
      corners[6], corners[7],
      confidence.toDouble(),
    )
  }

  /** Index of the first (or last) entry at or above `limit`, else -1. */
  private fun firstAbove(profile: IntArray, limit: Int, forward: Boolean): Int {
    val range = if (forward) profile.indices else profile.indices.reversed()
    for (i in range) if (profile[i] >= limit) return i
    return -1
  }

  /**
   * Otsu's method: pick the intensity that maximises between-class variance.
   * It adapts to room lighting without any exposed knob.
   *
   * A page against a dark desk gives a histogram with two tight spikes and a
   * dead flat valley between them, so every threshold in that valley scores
   * identically. Taking the first one would sit the threshold right on the
   * background peak and classify the whole frame as page, so we track the
   * whole maximal plateau and cut down its middle.
   *
   * Mirrored in src/lib/pageDetect.ts, which drives the web build.
   */
  private fun otsu(hist: IntArray, total: Int): Int {
    var sum = 0L
    for (i in 0..255) sum += i.toLong() * hist[i]

    var sumBackground = 0L
    var weightBackground = 0
    var best = -1.0
    var plateauStart = 127
    var plateauEnd = 127

    for (t in 0..255) {
      weightBackground += hist[t]
      if (weightBackground == 0) continue
      val weightForeground = total - weightBackground
      if (weightForeground == 0) break

      sumBackground += t.toLong() * hist[t]
      val meanBackground = sumBackground.toDouble() / weightBackground
      val meanForeground = (sum - sumBackground).toDouble() / weightForeground
      val between =
        weightBackground.toDouble() * weightForeground * (meanBackground - meanForeground) *
          (meanBackground - meanForeground)

      if (between > best) {
        best = between
        plateauStart = t
        plateauEnd = t
      } else if (between == best) {
        plateauEnd = t
      }
    }

    val threshold = Math.round((plateauStart + plateauEnd) / 2.0).toInt()

    // Bias slightly toward the page: pencil strokes sit just below the paper's
    // brightness and should not carve holes out of the mask.
    return max(0, min(250, threshold - 6))
  }

  /**
   * Rotate an axis-aligned box from buffer space into display space and emit
   * it as eight floats, clockwise from top-left.
   */
  private fun rotateToDisplay(
    x0: Float,
    y0: Float,
    x1: Float,
    y1: Float,
    degrees: Int,
  ): DoubleArray {
    val points = arrayOf(
      floatArrayOf(x0, y0),
      floatArrayOf(x1, y0),
      floatArrayOf(x1, y1),
      floatArrayOf(x0, y1),
    )

    val rotated = points.map { (px, py) ->
      when (((degrees % 360) + 360) % 360) {
        90 -> floatArrayOf(1f - py, px)
        180 -> floatArrayOf(1f - px, 1f - py)
        270 -> floatArrayOf(py, 1f - px)
        else -> floatArrayOf(px, py)
      }
    }

    // Rotation reshuffles which corner is which, so re-anchor on the one
    // nearest the display origin and walk clockwise from there.
    val cx = rotated.sumOf { it[0].toDouble() } / 4
    val cy = rotated.sumOf { it[1].toDouble() } / 4
    val clockwise = rotated.sortedBy { Math.atan2(it[1] - cy, it[0] - cx) }
    val startIndex = clockwise.indices.minByOrNull {
      val p = clockwise[it]
      p[0] * p[0] + p[1] * p[1]
    } ?: 0

    val out = DoubleArray(8)
    for (i in 0 until 4) {
      val p = clockwise[(startIndex + i) % 4]
      out[i * 2] = p[0].toDouble()
      out[i * 2 + 1] = p[1].toDouble()
    }
    return out
  }
}

/** VisionCamera reports orientation as an enum; we only need the angle. */
private fun com.mrousavy.camera.core.types.Orientation.toDegrees(): Int = when (this) {
  com.mrousavy.camera.core.types.Orientation.PORTRAIT -> 0
  com.mrousavy.camera.core.types.Orientation.LANDSCAPE_LEFT -> 90
  com.mrousavy.camera.core.types.Orientation.PORTRAIT_UPSIDE_DOWN -> 180
  com.mrousavy.camera.core.types.Orientation.LANDSCAPE_RIGHT -> 270
}
